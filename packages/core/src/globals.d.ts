// Minimal declarations for the two WHATWG globals @tap/core relies on. They exist in every
// supported runtime (Node >= 11, all browsers, VS Code webviews). Declaring them here instead of
// pulling in the DOM or Node type libraries keeps the core from accidentally using other
// platform-specific APIs.
declare class TextEncoder {
  encode(input?: string): Uint8Array;
}
declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean });
  decode(input?: Uint8Array): string;
}
