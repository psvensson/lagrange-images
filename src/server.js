import {createServer} from 'node:http';
import {fileURLToPath} from 'node:url';
import {createRuntime} from './runtime.js';

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function send(response, status, body) {
  response.writeHead(status, {'content-type': 'application/json; charset=utf-8'});
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function pathParts(url) {
  return new URL(url, 'http://localhost').pathname.split('/').filter(Boolean);
}

async function createImageHttpServer({runtime = null} = {}) {
  const ownedRuntime = runtime ?? await createRuntime();
  const ownsRuntime = runtime === null;

  const server = createServer(async (request, response) => {
    try {
      const parts = pathParts(request.url);

      if (request.method === 'GET' && parts.length === 1 && parts[0] === 'health') {
        return send(response, 200, {
          ok: true,
          backend: ownedRuntime.backend.kind,
          durable: ownedRuntime.backend.durable ?? null,
          integration: ownedRuntime.backend.integration ?? null,
        });
      }

      if (request.method === 'GET' && parts.length === 1 && parts[0] === 'images') {
        return send(response, 200, await ownedRuntime.images.listImages());
      }

      if (request.method === 'POST' && parts.length === 1 && parts[0] === 'images') {
        return send(response, 201, await ownedRuntime.images.createImage(await readJson(request)));
      }

      if (parts[0] === 'images' && parts[1]) {
        const imageId = decodeURIComponent(parts[1]);

        if (request.method === 'GET' && parts.length === 2) {
          return send(response, 200, await ownedRuntime.images.getImage(imageId));
        }

        if (request.method === 'GET' && parts[2] === 'records' && parts.length === 3) {
          return send(response, 200, await ownedRuntime.images.listRecords(imageId));
        }

        if (request.method === 'GET' && parts[2] === 'shapes' && parts.length === 3) {
          return send(response, 200, await ownedRuntime.images.listShapes(imageId));
        }

        if (request.method === 'PUT' && parts[2] === 'shapes' && parts[3]) {
          return send(response, 201, await ownedRuntime.images.putShape(imageId, {
            ...await readJson(request),
            id: decodeURIComponent(parts[3]),
          }));
        }

        if (request.method === 'GET' && parts[2] === 'objects' && parts.length === 3) {
          return send(response, 200, await ownedRuntime.images.listObjects(imageId));
        }

        if (request.method === 'PUT' && parts[2] === 'objects' && parts[3]) {
          const {expectedVersion, ...object} = await readJson(request);
          return send(
            response,
            200,
            await ownedRuntime.images.putObject(
              imageId,
              {...object, id: decodeURIComponent(parts[3])},
              {expectedVersion},
            ),
          );
        }

        if (request.method === 'GET' && parts[2] === 'history' && parts.length === 3) {
          return send(response, 200, await ownedRuntime.images.history(imageId));
        }

        if (request.method === 'POST' && parts[2] === 'snapshots' && parts.length === 3) {
          return send(response, 201, await ownedRuntime.images.snapshot(imageId, await readJson(request)));
        }
      }

      return send(response, 404, {error: 'not found'});
    } catch (error) {
      return send(response, 400, {
        error: error.name,
        message: error.message,
      });
    }
  });

  server.closeRuntime = async () => {
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
    if (ownsRuntime) await ownedRuntime.close();
  };

  return server;
}

async function main() {
  const port = Number(process.env.PORT ?? 7331);
  const server = await createImageHttpServer();
  server.listen(port, '127.0.0.1', () => {
    console.log(`lagrange-images listening on http://127.0.0.1:${port}`);
  });
}

const isEntrypoint = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntrypoint) await main();

export {createImageHttpServer};
