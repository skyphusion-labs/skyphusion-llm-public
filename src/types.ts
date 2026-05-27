// Shared request types (v0.19.2).
//
// Extracted from src/index.ts so provider modules can typecheck attachment
// handling. The `InputAttachment` discriminated union (v0.17.1) is the shape
// the worker accepts on the request boundary; providers that consume
// attachments directly (e.g., Bedrock Pegasus for video-Q&A) import the
// narrow variant types via `find` with a type predicate, and TypeScript
// narrows correctly thanks to the discriminator.
//
// PersistedAttachment family (the D1 storage shape after R2 upload) is not
// included here for now; only the worker entry deals with persistence,
// providers only see the in-flight Input shape.

export interface InputImageAttachment {
  type: "image";
  data: string;        // data URL
  mime?: string;
  filename?: string;
}
export interface InputAudioAttachment {
  type: "audio";
  data: string;        // data URL
  mime?: string;
  filename?: string;
}
export interface InputVideoFramesAttachment {
  type: "video_frames";
  frames: string[];    // array of data URLs (one per keyframe)
  duration?: number;
  filename?: string;
}
export interface InputVideoFullAttachment {
  type: "video_full";
  data: string;        // data URL
  mime?: string;
  filename?: string;
}
export type InputAttachment =
  | InputImageAttachment
  | InputAudioAttachment
  | InputVideoFramesAttachment
  | InputVideoFullAttachment;
