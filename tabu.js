const cobs = require('cobs');
const SerialPort = require('serialport');
const EventEmitter = require('events');
const fs = require('fs');

function makeid(length) {
  var result           = '';
  //Lowercase p intentionally omitted
  var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnoqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for ( var i = 0; i < length; i++ ) {
     result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

class Message extends EventEmitter {
  constructor(robot, address, content, id) {
    super();
    this.contentStr = JSON.stringify(content).replace(/p/g, '\\u0070');
    this.content = content;
    Object.assign(this, {robot, address, id: id || makeid(8), pos: null});
    this.on('newListener', (evt, listen) => {
      if(evt === 'reply') {
        if(this.robot.orphanReplies[this.id]) {
          try {
            listen(this.robot.orphanReplies[this.id]);
          } catch(e) {
            console.log('Exception occurred in handling reply message: ' + e);
          }
          //Hacky, but I can't think of a better way.
          setTimeout(() => this.removeAllListeners('reply'), 0);
        } else {
          this.robot.waitingReplies[this.id] = this;
        }
      }
    });
  }

  set content(to) { this._content = to; this.contentStr = JSON.stringify(to).replace(/p/g, '\\u0070'); }
  get content() { return this._content; }
  get text() { return `${this.address}/${this.id}/${this.contentStr}`.replace(/p/g, '\\u0070'); }
  get encoded() { return this.text + '\n'; }

  reply(content) {
    return new Message(this.robot, `@${this.id}`, content).resend();
  }
  
  replyBig(content) {
    return new Message(this.robot, `@${this.id}`, content).resendBig();
  }

  resend() {
    return new Promise((res, rej) => {
      //console.log("TO ROBOT: ", this.text);
      this.robot.port.write(this.encoded, err => {
        if(err) {
          rej(err); return;
        }
        res(this);
      });
    });
  }

  resendBig() {
    return new Promise((resolve, reject) => {
      this.pos = 0;
      this.on('big-transfer-done', resolve);
      this.on('big-transfer-fail', reject);
      this.continueBig();
    });
  }

  async continueBig() {
    //Send 1024 characters of content.
    let nextData = this.contentStr.substr(this.pos, 1024);
    this.pos += nextData.length;
    let pieceOut = (await new Message(this.robot, `=file-transfer`, {
      origID: this.id,
      origAddr: this.address,
      nextData,
      done: this.pos === this.contentStr.length
    }).resend());
    if(this.robot.replyInBigTransfers) {
      pieceOut.once('reply', () => {
        if(this.pos === this.contentStr.length) {
          //When transfer is done, send back this message.
          this.emit('big-transfer-done', this);
        } else {
          this.continueBig();
        }
      }).on('error', e => this.emit('big-transfer-fail', e));
    } else {
      //Purely to avoid a stack overflow
      setTimeout(() => this.continueBig(), 0);
    }
  }
}

class Robot extends EventEmitter {
  constructor(path, name) {
    super();
    this.waitingReplies = [];
    this.orphanReplies = [];
    this.ongoingTransfers = {};
    this.replyInBigTransfers = true;
    this.port = new SerialPort(path, {
      baudRate: 115200,
      lock: false
    });
    this.port.on('error', err => this.emit('error', err));
    this.receivedText = [];
    let onData = buf => {
      this.receivedText.push(buf);
      if(buf.includes('\n'.charCodeAt(0))) {
        let allReceived = Buffer.concat(this.receivedText);
        let line = allReceived.slice(0, allReceived.indexOf('\n'.charCodeAt(0)));
        onLine(line);
        this.receivedText = [];
        onData(buf.slice(buf.indexOf('\n'.charCodeAt(0)) + 1));
      }
    };
    this.received = [];
    let onCOBSData = buf => {
      this.received.push(buf);
      if(buf.includes(0)) {
        let allReceived = Buffer.concat(this.received);
        let cobsData = allReceived.slice(0,allReceived.indexOf(0));
        onData(cobs.decode(cobsData).slice(4));
        this.received = [];
        onCOBSData(buf.slice(buf.indexOf(0) + 1));
      }
    };
    this.port.on('data', onCOBSData);
    this.port.on('open', () => {
      this.port.write('pRb');
      this.sendMessage("connect", { name });
      this.emit('open');
    });
    let onLine = line => {
      line = line.toString('UTF-8');
      console.log(line);
      try {
        let match = /^([=@][^/]+)\/([^/]{8})\/(.*)$/.exec(line.replace('\n', ''));
        if(!match) throw 'Not valid message';
        let msg = new Message(this, JSON.parse(`"${match[1]}"`), JSON.parse(match[3]), match[2]);
        //console.log("FROM ROBOT", msg.text);
        let title = msg.address.slice(1);
        if(msg.address.startsWith('@')) {
          if(this.waitingReplies[title]) {
            try {
              this.waitingReplies[title].emit('reply', msg);
            } catch(e) {
              console.log('Exception occurred in handling reply message: ' + e);
            }
            delete this.waitingReplies[title];
          } else {
            this.orphanReplies[title] = msg;
          }
        } else {
          if(title === 'file-transfer') {
            let xfer = this.ongoingTransfers[msg.content.origAddr];
            if(!xfer) {
              xfer = this.ongoingTransfers[msg.content.origAddr] = {
                text: "",
                address: msg.content.origAddr,
                id: msg.content.origID
              };
            }
            xfer.text += msg.content.nextData;
            //Always send a reply.
            console.log('checkpoint 1');
            msg.reply({});
            if(msg.content.done) {
              //Delete ongoingTransfer.
              delete this.ongoingTransfers[msg.content.origAddr];
              //Reconstruct message from stringified JSON in .text and xfer metadata.
              //Recurse with text representation.
              onLine(new Message(this, xfer.address, JSON.parse(xfer.text), xfer.id).encoded);
            }
          } else {
            try {
              this.emit('event-' + title, msg);
            } catch(e) {
              console.log('Exception occurred in handling event message: ' + e);
            }
          }
        }
      } catch(e) {
        console.log(line);
      }
    };
  }

  sendMessage(topic, content) {
    if(content === undefined) content = null;
    return new Message(this, `=${topic}`, content).resend();
  }

  sendReply(id, content) {
    if(content === undefined) content = null;
    return new Message(this, `@${id}`, content).resend();
  }

  sendBigMessage(topic, content) {
    if(content === undefined) content = null;
    return new Message(this, `=${topic}`, content).resendBig();
  }

  sendBigReply(id, content) {
    if(content === undefined) content = null;
    return new Message(this, `@${id}`, content).resendBig();
  }

  sendRequest(topic, content) {
    if(content === undefined) content = null;
    return new Promise((res, rej) => {
      new Message(this, `=${topic}`, content).resend().then(msg => {
        msg.on('reply', reply => {
          res(reply);
        });
      }).catch(rej);
    });
  }

  close() {
    return new Promise((res, rej) => {
      this.port.close(err => {
        if(err) {
          rej(err); return;
        }
        res();
      });
    });
  }
};

module.exports = function(path, name) {
  return new Robot(path, name);
};
