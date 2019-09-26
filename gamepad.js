const EventEmitter = require('events');
const emitter = new EventEmitter();

setInterval(pollGamepads, 10);

emitter.previousGamepadValues = {};

function pollGamepads() {
  let gamepads = navigator.getGamepads ? navigator.getGamepads() : (navigator.webkitGetGamepads ? navigator.webkitGetGamepads : []);
  for (let ind = 0; ind < gamepads.length; ind++) {
    let gp = gamepads[ind];
    if (gp) {
      if(!emitter.previousGamepadValues[ind]) {
        emitter.previousGamepadValues[ind] = {
          buttons: {},
          axes: {}
        };
      }
      let prev = emitter.previousGamepadValues[ind];
      //Check for updates in buttons
      for(let i in gp.buttons) {
        if(gp.buttons[i].pressed !== prev.buttons[i]) {
          prev.buttons[i] = gp.buttons[i].pressed;
          emitter.emit('key', {
            index: parseInt(ind),
            num: parseInt(i),
            pressed: gp.buttons[i].pressed
          });
        }
      }
      //Check for updates in axes
      for(let i in gp.axes) {
        if(gp.axes[i] !== prev.axes[i]) {
          prev.axes[i] = gp.axes[i];
          emitter.emit('move', {
            index: parseInt(ind),
            axis: parseInt(i),
            value: gp.axes[i]
          });
        }
      }
    }
  }
}

module.exports = emitter;