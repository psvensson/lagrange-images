import {createServer} from 'node:http';
import {createRuntime} from './runtime.js';

const runtime = await createRuntime();

async function body(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
}

function reply(response, status, value) {
  response.writeHead(status, {'content-type': 'application/json'});
  response.end(JSON.stringify(value));
}

createServer(async (request, response) => {
  try {
    const path = new URL(request.url, 'http://localhost').pathname.split('/').filter(Boolean);
    if (request.method === 'GET' && path[0] === 'health') {
      return reply(response, 200, {ok: true, backend: runtime.backend.kind});
    }
    if (request.method === 'POST' && path[0] === 'images' && path.length === 1) {
      return reply(response, 201, await runtime.images.createImage(await body(request)));
    }
    if (request.method === 'PUT' && path[0] === 'images' && path[2] === 'shapes' && path[3]) {
      return reply(response, 201, await runtime.images.putShape(path[1], {...await body(request), id: path[3]}));
    }
    if (request.method === 'PUT' && path[0] === 'images' && path[2] === 'objects' && path[3]) {
      return reply(response, 200, await runtime.images.putObject(path[1], {...await body(request), id: path[3]}));
    }
    if (request.method === 'GET' && path[0] === 'images' && path[2] === 'records') {
      return reply(response, 200, await runtime.images.listRecords(path[1]));
    }
    return reply(response, 404, {error: 'not found'});
  } catch (error) {
    return reply(response, 400, {error: error.name, message: error.message});
  }
}).listen(Number(process.env.PORT ?? 7331), '127.0.0.1');
