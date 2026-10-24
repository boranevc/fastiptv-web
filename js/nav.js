// Remote-control navigation: up/down inside a container, left/right between containers.
// webOS: Back = 461, CH+ = 427, CH- = 428.
export const KEY = { LEFT: 37, UP: 38, RIGHT: 39, DOWN: 40, OK: 13, BACK: 461, ESC: 27, BKSP: 8, CH_UP: 427, CH_DOWN: 428, PGUP: 33, PGDN: 34, YELLOW: 405, RED: 403, GREEN: 404, BLUE: 406, F: 70, S: 83, D: 68, T: 84, INFO: 457, PLAY: 415, PAUSE: 19, STOP: 413, RW: 412, FF: 417 };

let focused = null;

export function focus(el) {
  if (!el) return;
  focused?.classList.remove('focus');
  focused = el;
  el.classList.add('focus');
  el.focus({ preventScroll: true });
  const col = el.closest('.col, .scroller');
  if (col) {
    const top = el.offsetTop;
    col.scrollTop = Math.max(0, top - col.clientHeight / 2);
  }
}

export const items = (container) => [...container.querySelectorAll('.item:not([hidden])')].filter((e) => e.offsetParent);

export function move(container, delta) {
  const list = items(container);
  const i = Math.max(0, list.indexOf(focused));
  focus(list[Math.min(list.length - 1, Math.max(0, i + delta))]);
}

export const current = () => focused;
