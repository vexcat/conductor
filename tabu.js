const cobs = require('cobs');
const SerialPort = require('serialport');
const EventEmitter = require('events');
const fs = require('fs');

function makeid(length) {
  var result           = '';
  var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for ( var i = 0; i < length; i++ ) {
     result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

function encode(str) {
  //lowercase p is not allowed, is the command character in PROS
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno@qrstuvwxyz0123456789-_='
  var encoded = [];
  var c = 0;
  while (c < str.length) {
    var b0 = str.charCodeAt(c++);
    var b1 = str.charCodeAt(c++);
    var b2 = str.charCodeAt(c++);
    var buf = (b0 << 16) + ((b1 || 0) << 8) + (b2 || 0);
    var i0 = (buf & (63 << 18)) >> 18;
    var i1 = (buf & (63 << 12)) >> 12;
    var i2 = isNaN(b1) ? 64 : (buf & (63 << 6)) >> 6;
    var i3 = isNaN(b2) ? 64 : (buf & 63);
    encoded[encoded.length] = chars.charAt(i0);
    encoded[encoded.length] = chars.charAt(i1);
    encoded[encoded.length] = chars.charAt(i2);
    encoded[encoded.length] = chars.charAt(i3);
  }
  return encoded.join('');
}

function decode(str) {
  var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno@qrstuvwxyz0123456789-_=',
      invalid_char = /[^ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmno@qrstuvwxyz0123456789-_=]/;

  var invalid = {
    strlen: (str.length % 4 != 0),
    chars:  invalid_char.test(str),
    equals: (/=/.test(str) && (/=[^=]/.test(str) || /={3}/.test(str)))
  };
  if (invalid.strlen || invalid.chars || invalid.equals)
    throw new Error('Invalid base64 data');
  var decoded = [];
  var c = 0;
  while (c < str.length) {
    var i0 = chars.indexOf(str.charAt(c++));
    var i1 = chars.indexOf(str.charAt(c++));
    var i2 = chars.indexOf(str.charAt(c++));
    var i3 = chars.indexOf(str.charAt(c++));
    var buf = (i0 << 18) + (i1 << 12) + ((i2 & 63) << 6) + (i3 & 63);
    var b0 = (buf & (255 << 16)) >> 16;
    var b1 = (i2 == 64) ? -1 : (buf & (255 << 8)) >> 8;
    var b2 = (i3 == 64) ? -1 : (buf & 255);
    decoded[decoded.length] = String.fromCharCode(b0);
    if (b1 >= 0) decoded[decoded.length] = String.fromCharCode(b1);
    if (b2 >= 0) decoded[decoded.length] = String.fromCharCode(b2);
  }
  return decoded.join('');
}

class Message extends EventEmitter {
  constructor(robot, address, content, id) {
    super();
    this.contentStr = JSON.stringify(content);
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

  set content(to) { this._content = to; this.contentStr = JSON.stringify(to); }
  get content() { return this._content; }
  get text() { return `${this.address}/${this.id}/${this.contentStr}`; }
  get encoded() { return encode(this.text) + '\n'; }

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
    (await new Message(this.robot, `=file-transfer`, {
      origID: this.id,
      origAddr: this.address,
      nextData,
      done: this.pos === this.contentStr.length
    }).resend()).once('reply', () => {
      if(this.pos === this.contentStr.length) {
        //When transfer is done, send back this message.
        this.emit('big-transfer-done', this);
      } else {
        this.continueBig();
      }
    }).on('error', e => this.emit('big-transfer-fail', e));
  }
}

class Robot extends EventEmitter {
  constructor(path, name) {
    super();
    this.waitingReplies = [];
    this.orphanReplies = [];
    this.ongoingTransfers = {};
    this.port = new SerialPort(path, {
      baudRate: 115200,
      lock: false
    });
    this.port.on('error', err => this.emit('error', err));
    this.receivedText = [];
    let onData = buf => {
      console.log('in onData');
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
      console.log('in onCOBSData');
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
      console.log('in onLine')
      line = line.toString('UTF-8');
      try {
        let match = /^([=@][^/]+)\/([^/]{8})\/(.*)$/.exec(decode(line.replace('\n', '')));
        if(!match) throw 'Not valid message';
        let msg = new Message(this, match[1], JSON.parse(match[3]), match[2]);
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
