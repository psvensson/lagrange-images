// The deterministic ids ADR 0054's condition classes live at.
//
// Deliberately dependency-free and separate from `smalltalk-conditions.js`: the primitives need
// these ids to raise a host failure as a Smalltalk condition, while the installer needs the
// primitives — so putting them in either module makes those two import each other.
const EXCEPTION_SHAPE_ID = 'smalltalk/exception-instance-shape/v1';

// Decision 8's "now" set: existing host errors that gain a Smalltalk-visible class.
const HOST_CONDITION_CLASS = Object.freeze({
  zeroDivide: 'smalltalk/class/ZeroDivide',
  indexBounds: 'smalltalk/class/IndexBounds',
  keyNotFound: 'smalltalk/class/KeyNotFound',
});

export {EXCEPTION_SHAPE_ID, HOST_CONDITION_CLASS};
