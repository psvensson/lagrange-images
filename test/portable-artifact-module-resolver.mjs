// Re-export of the Images-owned resolution rule, so the differential harness never
// reimplements closure semantics. `src/portable-artifact/module-closure.js` is the ONE
// owner; a consumer host implements this same documented rule in its own language.
export {resolveLogicalPath, resolutionCandidates} from '../src/portable-artifact/module-closure.js';
