---
id: image-service-surface
status: open
proof: deterministic
legacy: false
roadmapRow: image-service HTTP surface under contract test
graduatesTo: null
quests:
  - http-server-contract-coverage
authorizes: []
legacyStatus: null
---

# Epic: image-service surface

Owns the committed quest discipline for the public image-service surface:
the HTTP API in `src/server.js` is the durable product boundary of this
service and every route on it must be under machine-checked contract test.
