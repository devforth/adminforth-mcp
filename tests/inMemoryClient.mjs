/** Speaks JSON-RPC over the client end of an in-memory MCP connection, after the legacy initialize handshake. */
export async function connectClient(transport) {
  const responses = new Map();
  let nextId = 1;
  transport.onmessage = (message) => responses.get(message.id)?.(message);
  await transport.start();
  const request = (method, params = {}) => {
    const id = nextId++;
    return {
      id,
      response: new Promise((resolve) => {
        responses.set(id, resolve);
        transport.send({ jsonrpc: '2.0', id, method, params });
      }),
    };
  };
  const initialize = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-client', version: '1.0.0' },
  }).response;
  await transport.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  return {
    initialize: initialize.result,
    request,
    call: async (method, params) => (await request(method, params).response).result,
    cancel: (requestId) => transport.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId } }),
  };
}
