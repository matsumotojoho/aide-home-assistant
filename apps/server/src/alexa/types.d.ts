declare module 'alexa-verifier' {
  function verifier(
    certUrl: string,
    signature: string,
    requestBody: string,
    callback: (error?: Error | string | null) => void,
  ): void;
  export default verifier;
}
