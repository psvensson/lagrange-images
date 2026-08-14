const SYMMETRIC_SMALLTALK = Object.freeze({
  id: 'symmetric-smalltalk',
  name: 'Symmetric Smalltalk',
  status: 'seed',
  executionModel: 'image-resident',
  principles: Object.freeze([
    'everything user-visible is an object',
    'message send is the ordinary composition mechanism',
    'blocks are the uniform executable/compositional representation',
    'language implementation should become image-resident over time',
    'syntax is a language personality, not a persistence boundary',
  ]),
  capabilities: Object.freeze({
    parse: true,
    compile: true,
    evaluate: true,
    bootstrap: false,
  }),
});

export {SYMMETRIC_SMALLTALK};
