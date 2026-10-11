type Impl = (...args: Array<any>) => any;

const isomorphic = (client?: Impl): any =>
  Object.assign((...args: Array<any>) => client?.(...args), {
    client: (impl: Impl) => isomorphic(impl),
    server: (_impl: Impl) => isomorphic(client),
  });

/**
 * Always the `.client()` branch: browser tests run what the client bundle runs. Start's own
 * runtime fallback returns whichever branch is chained last, which here is `.server()`.
 */
export const createIsomorphicFn = () => isomorphic();
