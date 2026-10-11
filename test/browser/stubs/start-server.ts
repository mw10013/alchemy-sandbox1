/** Only a `.server()` branch reads it, and the browser stub of `createIsomorphicFn` never runs one. */
export const getRequestHeader = (_name: string): string | undefined => undefined;
