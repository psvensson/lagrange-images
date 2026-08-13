const SYMMETRIC_SMALLTALK = Object.freeze({
  id: 'symmetric-smalltalk',
  name: 'Symmetric Smalltalk',
  status: 'designing',
  executionModel: 'image-resident',
  principles: Object.freeze([
    'everything user-visible is an object',
    'message send is the ordinary composition mechanism',
    'blocks are the uniform executable/compositional representation',
    'language implementation should become image-resident over time',
    'syntax is a language personality, not a persistence boundary',
  ]),
  capabilities: Object.freeze({
    parse: false,
    compile: false,
    evaluate: false,
    bootstrap: false,
  }),
});

export {SYMMETRIC_SMALLTALK};
