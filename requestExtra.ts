import type { HttpExtra, IAdminForthEndpointHandlerInput } from 'adminforth';

export function requestExtra(input: IAdminForthEndpointHandlerInput): HttpExtra {
  return {
    body: input.body,
    query: input.query,
    headers: input.headers,
    cookies: input.cookies,
    requestUrl: input.requestUrl,
    response: input.response,
  };
}
