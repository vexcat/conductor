const { EventEmitter } = require('events');
const { remote } = require('electron');
const { spawn } = require('child_process');
const pEvent = require('p-event');
const fs = require('fs');

const Chart = require('chart.js');
const dialog = remote.dialog;
const Menu = remote.Menu;
let dev = '/dev/rfcomm1';
let sysdev = '/dev/rfcomm0';
$('.serial-loc').text(dev);
$("#connection").show();
const tabu = require('./tabu');

function checkRegistry() {
  bot.sendRequest('help').then(help => { update(help.content); });
}

$('#registry-refresh').click(checkRegistry);

let bot;
let reconnect = async () => {
  try {
    await bot.close();
  } catch(e) {}
  $('.connection-status').text('CONNECTING');
  bot = tabu(dev, 'canada');
  bot.on('open', () => {
    $('.connection-status').text('CONNECTED');
    checkRegistry();
  });
  bot.on('error', () => {
    $('.connection-status').text('FAILED');
    for(let window of openWindows) {
      window.disconnect();
    }
    console.log('Robot disconnected.');
  });
};
reconnect();

const ctrl = require('./gamepad');
const windowEvents = new EventEmitter();

function makeid(length) {
  var result           = '';
  var characters       = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  var charactersLength = characters.length;
  for ( var i = 0; i < length; i++ ) {
     result += characters.charAt(Math.floor(Math.random() * charactersLength));
  }
  return result;
}

function makeGraphElement(graphable, axis, title) {
  let colors = ['#ff0000', '#0000ff', '#00bb00', '#000000']
  //Reformats data to be lists of values and not a list of points.
  let reformat = (data, xAxisName) => {
    let result = {};
    for(let point of data) {
      for(let key in point) {
        result[key] = result[key] || [];
        result[key].push(point[key]);
      }
    }
    let x = result[xAxisName];
    delete result[xAxisName];
    let colorNum = 0;
    return {
      labels: x,
      datasets: Object.entries(result).map(listpair => ({
        data: listpair[1],
        label: listpair[0],
        fill: false,
        borderColor: colors[colorNum++ % colors.length]
      }))
    };
  }
  let formatted = reformat(graphable, axis);
  let ctx = $('<canvas>');
  new Chart(ctx, {
    data: formatted,
    type: 'line',
    options: {
      title: title ? {
        display: true,
        text: title
      } : undefined,
      hover: {
        animationDuration: 50,
        intersect: false,
        axis: 'x'
      },
      tooltips: {
        mode: 'index',
        intersect: false,
      },
      elements: {
        point: {
          pointStyle: 'line'
        }
      }
    }
  });
  return $('<div>').append($('<div>').addClass('chart-box').append(ctx)).append($('<a href="#">').text('as .csv').click(() => {
    let columns = [];
    for(let dataset of formatted.datasets) {
      columns.push(dataset.label);
    }
    let csv = [axis + ',' + columns.join(',')];
    for(let i = 0; i < formatted.labels.length; i++) {
      let line = formatted.labels[i];
      for(let dataset of formatted.datasets) {
        line += ',' + dataset.data[i];
      }
      csv.push(line);
    }
    csv = csv.join('\n') + '\n';
    const path = dialog.showSaveDialog(null);
    fs.writeFileSync(path, csv);
  }));
}

async function animateWindow(wind, prop, from, to, nsteps, cb) {
  if(!wind.setProp) wind = openWindows.find(w => w.templateName === wind);
  wind.setProp(prop, from);
  let step = nsteps === 0 ? 0 : (to - from) / nsteps;
  let ret = [];
  for(let i = 0; i < nsteps + 1; i++) {
    wind.setProp(prop, from);
    ret.push(await cb(wind, from));
    from += step;
  }
  return ret;
}

function selectTemplate(named) {
  return $('#template-holder .' + named.replace(/\./g, '\\.'));
}

function update(help) {
  $('.robot_registry-status').text('Registry:');
  $('.robot_registry-list').empty().append(Object.entries(help).map(entry => {
    return $('<li>').append($('<a href="#"></a>').text(entry[0]).click(() => {
      buildUI(entry[0], entry[1]);
      new TabiWindow(entry[0]);
    }));
  }));
}
function buildUI(named, content) {
  if(selectTemplate(named).length === 0) {
    $('#template-holder').append($('<div>').addClass(named).append(content.map(elem => {
      return ({
        label:  () => $('<p>').text(elem.text),
        number: () => $('<input type="text">').attr({name: elem.key, 'data-type': 'number'}).append('<span>inline</span>'),
        string: () => $('<input type="text">').attr({name: elem.key}),
        bool:   () => $('<input type="checkbox">').attr({name: elem.key, 'data-type': 'boolean'}),
        reply_action: () => {}
      })[elem.kind]();
    })).append($('<button>Go</button>').addClass('animatable')));
  }
  windows[named] = class extends EventEmitter {
    constructor(w) {
      super();
      this.windowTitle = named;
      w.contentDOM.find('button.animatable').click(async () => {
        await this.doTest(true);
      });
      content.forEach(val => {
        if(val.key) {
          this[val.key] = {
            number: 0,
            string: "",
            bool: false
          }[val.kind];
        }
      });
    }
    doTest(shouldOpenWindow) {
      return new Promise((res, rej) => {
        let reqData = content.reduce((acc, val) => {
          if(val.key) {
            acc[val.key] = this[val.key];
          }
          return acc;
        }, {});
        bot.sendRequest(named, reqData, {}).then(response => {
          this.emit('data', response.content);
          let js = content.find(a => a.kind === 'reply_action').do;
          res(processOutput(response.content, js, this, shouldOpenWindow));
        });
      });
    }
  }
}
function processOutput(it, action, builtUI, shouldOpenWindow) {
  let output = $('<div>').addClass('robot-output');
  function graph(graphable, axis) {
    if(axis === undefined) axis = 'time';
    output.append(makeGraphElement(graphable, axis));
  }
  function say(text) {
    output.append($('<p>').text(text));
  }
  eval(action);
  if(shouldOpenWindow) {
    let win = new TabiWindow('output', builtUI.windowTitle);
    win.contentDOM.append(output)
    .append($('<button>Retry</button>').addClass('again').click(async () => {
      let newOutput = await builtUI.doTest(false);
      output.empty().append(newOutput.children());
    }));
  }
  return output;
}

let windows = {
  connector: function(w) {
    w.contentDOM.find('.reconnect').click(async () => {
      await reconnect();
    });
    w.contentDOM.find('.connector-sys-dev').val(sysdev);
    w.contentDOM.find('.connector-usr-dev').val(dev);
    w.contentDOM.find('.connector-dev-change').click(async () => {
      sysdev = w.contentDOM.find('.connector-sys-dev').val();
      dev = w.contentDOM.find('.connector-usr-dev').val();
    });
  },
  blue_control: function(w, tx, id) {
    this.gamepad_id = id || 'all';
    this.tx_prefix = tx || 'blue_control';
    this.status = w.contentDOM.find('.blue_control-status');
    let statusFor = state => {
      let repr = "";
      for(var ctrl_id in state) {
        repr += `Controller ${ctrl_id}: `;
        let gamepadState = [];
        for(let btn_id in state[ctrl_id].buttons) {
          gamepadState.push(`b${btn_id}=${state[ctrl_id].buttons[btn_id]}`);
        }
        for(let axis_id in state[ctrl_id].axes) {
          gamepadState.push(`a${axis_id}=${state[ctrl_id].axes[axis_id]}`);
        }
        repr += gamepadState.join(', ');
        repr += '\n';
      }
      return repr;
    };
    let listener = what => obj => {
      this.status.text(statusFor(ctrl.previousGamepadValues));
      if(this.gamepad_id === 'all' || ''+obj.index === this.gamepad_id) {
        bot.sendMessage(`${this.tx_prefix}.${what}`, obj);
      }
    };
    this.moveListener = listener('move');
    this.keyListener  = listener('key' );
    ctrl.on('move', this.moveListener);
    ctrl.on('key',  this.keyListener);
    w.on('disconnect-required', () => {
      ctrl.removeListener('move', this.moveListener);
      ctrl.removeListener('key', this.keyListener);
    });
  },
  screenshotter: class {
    constructor(w) {
      w.contentDOM.find('.screenshotter-go').click(() => {
        let loc = __dirname + '/' + makeid(8);
        let proc = spawn('prosv5', ['v5', 'capture', loc, sysdev], { stdio: 'ignore' });
        proc.on('exit', () => {
          w.contentDOM.find('.screenshotter-img').attr('src', 'file://' + loc + '.png');
        });
      });
    }
  },
  executor: class {
    constructor(w) {
      w.contentDOM.find('.executor-go').click(async () => {
        this.lines = [];
        try {
          await (eval(w.contentDOM.find('.executor-code').val()))();
        } catch(e) {
          this.lines.push('Whoops! An error occurred.');
          this.lines.push(e);
        }
        w.contentDOM.find('.executor-result').text(this.lines.join('\n'));
      });
    }
    log(text) {
      this.lines.push(text);
    }
  },
  cards: class {
    constructor(w, panels, title) {
      this.panels = panels;
      this.windowTitle = title;
      this.selected = 0;
      w.contentDOM.find('input[name=selected]').attr('max', panels.length - 1);
      /*
      this.windows = origWindows.map(obj => {
        let win = obj.win;
        let ret = win.contentDOM.detach();
        win.windowDOM.remove();
        win.windowDOM = win.contentDOM;
        //O(n^2) here but whatever
        openWindows = openWindows.filter(wind => {
          if(wind === win) return false;
          return true;
        });
        return {
          win: ret,
          name: obj.name
        };
      });
      */
      let display = w.contentDOM.find('.cards-displayed');
      let label = w.contentDOM.find('.cards-label');
      display.append(panels[0].win);
      label.text(panels[0].name);
      let pixar = 0;
      w.on('prop-change', key => {
        if(!pixar) pixar = requestAnimationFrame(() => {
          display.children().detach();
          display.append(panels[this.selected].win);
          label.text(panels[this.selected].name);
          pixar = 0;
        });
      });
    }
  },
  animator: function(w, targetWindow, targetProp) {
    w.contentDOM.find('.animator-what').text(targetProp);
    let title = targetWindow.windowDOM.find('.window-title').text();
    w.contentDOM.find('.animator-window-name').text(title);
    w.contentDOM.find('.animator-go').click(async () => {
      let ret = await animateWindow(targetWindow, targetProp, this.Initial, this.Final, this.Steps, async (wind, val) => {
        wind.setProp(targetProp, val);
        return {
          win: await wind.subject.doTest(false),
          name: targetProp + ' = ' + val
        }
      });
      new TabiWindow('cards', ret, `${targetProp} ${this.Initial} to ${this.Final} on ${title}`);
    });
  },
  output: function(w, testName) {
    this.windowTitle = 'Output - ' + testName;
  }
};

const kirakira = {
  blue_control: 'BlueControl',
  screenshotter: 'Screenshotter',
  executor: 'Executor',
  cards: 'Window Switcher',
  connector: 'Connector',
  output: 'Output'
};

const userAccessibleWindows = [
  'blue_control',
  'screenshotter',
  'executor',
  'connector'
];

$('#sidepanel-builtins').append(userAccessibleWindows.map(name => {
  return $('<a href="#"></a>').text(kirakira[name]).click(() => new TabiWindow(name)).add('<br>');
}))

const menu = Menu.buildFromTemplate([
  {
    label: 'Windows',
    submenu: userAccessibleWindows.map(name => ({
      label: kirakira[name],
      click() {
        new TabiWindow(name);
      }
    }))
  }
]);
Menu.setApplicationMenu(menu);

let lastPos = 10;
let openWindows = [];
class TabiWindow extends EventEmitter {
  constructor(templateName, ...pass) {
    super();
    this.templateName = templateName;
    openWindows.push(this);
    let a = windows[templateName] || function() {};
    this.windowDOM = $('#template-holder .window').clone().appendTo($('#window-container'));
    this.windowDOM.children().addClass('window-' + templateName)
    .mousedown(function() {
      if(!$(this).parent().is(':last-child'))
        $(this).parent().appendTo($(this).parent().parent())
    });
    let real = this.windowDOM.find('.window-real').append(this.contentDOM = selectTemplate(templateName)
    .clone().addClass('window-content'))
    .draggable({
      handle: '.window-top'//,
      //containment: $('body')
    }).resizable({
      handles: 'e, w'
    });
    let pos = this.windowDOM.position();
    real.css({left: lastPos - pos.left + 120, top: lastPos - pos.top});
    lastPos += 2;
    this.windowDOM.find('.window-close').on('click', () => this.destruct());
    let animatable = this.windowDOM.find('.animatable').length !== 0;
    let that = this;
    this.windowDOM.find('input').not('.auto-setter-exemption').each(function() {
      let pair = $('<div class="input-pair"></div>');
      pair.insertAfter($(this));
      let span = $('<span></span>').text($(this).attr('name') + ' =');
      if(animatable) {
        span.prepend($('<a href="#">%</a>').attr('tabindex', '-1').click(() => {
          new TabiWindow('animator', that, $(this).attr('name'));
        }));
      }
      pair.append(span);
      pair.append($(this).detach());
    });
    this.subject = new a(this, ...pass);
    this.windowDOM.find('.window-title').text(this.subject.windowTitle || kirakira[templateName]);
    this.windowDOM.find('input').not('.auto-setter-exemption').each(function() {
      let currentValue = that.subject[$(this).attr('name')];
      if($(this).attr('data-type') === 'boolean') {
        $(this).prop('checked', currentValue);
        return;
      }
      $(this).val(currentValue);
    }).on('input', function() {
      let val = $(this).val();
      if($(this).attr('data-type') === 'number') {
        val = parseFloat(val);
      } else if($(this).attr('data-type') === 'boolean') {
        val = $(this).is(':checked');
      }
      that.subject[$(this).attr('name')] = val;
      that.emit('prop-change', $(this).attr('name'));
    });
    this.emit('open');
    windowEvents.emit('newWindow', this);
  }
  disconnect() {
    if(!this.disconnected) {
      this.disconnected = true;
      this.emit('disconnect-required');
    }
  }
  destruct() {
    this.disconnect();
    this.windowDOM.remove();
    openWindows.splice(openWindows.indexOf(this), 1);
  }
  setProp(key, val) {
    this.subject[key] = val;
    this.contentDOM.find(`input[name=${key}]`).val(val);
  }
  getProp(key) {
    return this.subject[key];
  }
};

new TabiWindow('connector');
