'use strict';


/**
 * Map VideoPixelFormat enum to integers
 *
 * This is needed because WebAssembly only has numeric types.
 *
 * See also https://w3c.github.io/webcodecs/#enumdef-videopixelformat
 */
const videoPixelFormatIndex = [
  "I420",
  "I420A",
  "I422",
  "I444",
  "NV12",
  "RGBA",
  "RGBX",
  "BGRA",
  "BGRX"
];


/**
 * Returns a transformer for a TransformStream that can process a stream of
 * VideoFrames to replace green in a frame with the W3C blue color
 *
 * The transformer uses WebAssembly.
 */
function GreenBackgroundReplacer(config) {
  // We don't quite know yet what pixel format we will get for each decoded
  // video frame, but the worst arrangement possible (excluding HDR video)
  // should be one video plane with 4 bytes per pixel (RGBA):
  // https://w3c.github.io/webcodecs/#pixel-format
  // (note codedWidth and codedHeight could perhaps be different from width and
  // height, this should only work for "usual" video frame sizes)
  const memorySize = config.width * config.height * 4;

  // Pointer to the JS/WASM memory buffer
  let memory;

  // Pointer to the processFrame method exported by the WASM module 
  let processFrame;

  return {
    async start(controller) {
      // WebAssembly memory size is specified in pages of 64KB:
      // https://webassembly.github.io/spec/core/exec/runtime.html#page-size
      memory = new WebAssembly.Memory({
        initial: Math.ceil(memorySize / (64 * 1024))
      });

      // Load WebAssembly code and pass memory buffer to WebAssembly code
      const wasmResponse = await fetch('GreenBackgroundReplacer.wasm');
      const { instance } = await WebAssembly.instantiate(
        await wasmResponse.arrayBuffer(), {
          console: {
            log(arg) {
              console.log(arg);
            },
          },
          js: { mem: memory }
        }
      );
      processFrame = instance.exports.processFrame;
    },

    /**
     * Process a new frame and replace the green it contains with the W3C blue
     * color.
     */
    async transform(frame, controller) {
      // Copy frame bytes to WebAssembly memory
      await frame.copyTo(memory.buffer);

      // Process frame in WebAssembly
      processFrame(frame.codedWidth, frame.codedHeight, videoPixelFormatIndex.indexOf(frame.format));

      // Create new frame out of processed buffer
      const processedFrame = new VideoFrame(new Uint8Array(memory.buffer), {
        format: frame.format,
        codedWidth: frame.displayWidth,
        codedHeight: frame.displayHeight,
        timestamp: frame.timestamp,
        duration: frame.duration
      });

      // Time to get rid of the incoming VideoFrame and to return the newly
      // created one.
      frame.close();
      controller.enqueue(processedFrame);
    }
  };
}