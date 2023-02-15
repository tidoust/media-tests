'use strict';


/**
 * Returns a transformer for a TransformStream that moves the underlying memory
 * resources of the VideoFrame to CPU memory.
 */
function ToCPUMemoryCopier(config) {
  // Worst case scenario is 4 bytes per pixel
  const frameSize = config.width * config.height * 8;
  const buffer = new Uint8Array(frameSize);

  return {
    /**
     * Copy frame data to an ArrayBuffer and create a new VideoFrame based on
     * that.
     */
    async transform(frame, controller) {
      // Copy frame bytes to the buffer
      await frame.copyTo(buffer);
      
      // Create new frame out of processed buffer
      const processedFrame = new VideoFrame(buffer, {
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