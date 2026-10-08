# creator-tools: Paper unfold

Browser-only generator: image -> paper-unfold animation on a chroma-key background -> MP4.

## Run
No build step. Serve the folder over HTTP (ES modules and WebGL need it):

    python3 -m http.server 8080   # then open http://localhost:8080

Use current Chrome, Edge or Safari. MP4 export uses WebCodecs plus `mp4-muxer`, loaded from jsDelivr.
For production, vendor that file into `src/vendor/` and change `MUXER` in `src/engine.js`.
Without WebCodecs the engine falls back to real-time MediaRecorder (output may be WebM).

## Structure
- `src/engine.js`: GL helpers, `Renderer`, EXIF-aware image ingest, deterministic offline export.
- `src/effects/paper-unfold.js`: effect module (`defaults`, `ui` schema, `duration`, `init`, `render`).
- `index.html`: UI, built from the effect's `ui` schema. A new effect needs only a new module and one import.

## Notes
- Frame i is rendered at t = i/fps, so slow devices export the same video, only slower.
- Fold counts must divide 80 (2, 4, 5, 8) so creases align with the 160x160 mesh.
- Not included yet: background removal (use a transparent PNG with "Cut to shape"), HEIC input, alpha export.
  Verify any ONNX matting model's license before adding it commercially.
