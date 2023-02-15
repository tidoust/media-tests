'use strict';


/**
 * Returns a transformer for a TransformStream that converts an RGBX VideoFrame
 * to shades of grey.
 *
 * The transformer uses pure JavaScript.
 */
function BlackAndWhiteConverter(config) {
  // 4 bytes per pixel for RGBA/RGBX video frames
  const frameSize = config.width * config.height * 4;
  const buffer = new Uint8Array(frameSize);

  return {
    /**
     * Process a new frame and replace the green it contains with the W3C blue
     * color.
     */
    async transform(frame, controller) {
      // Copy frame bytes to the buffer
      await frame.copyTo(buffer);

      // Process frame in JavaScript, converting colors to grey
      // (using Y component of "YUV" formula: https://en.wikipedia.org/wiki/YUV)
      for (let pos = 0; pos < frameSize; pos += 4) {
        const shade = Math.round(
          0.2126 * buffer[pos] +
          0.7152 * buffer[pos+1] +
          0.0722 * buffer[pos+2]
        );
        buffer[pos] = shade;
        buffer[pos+1] = shade;
        buffer[pos+2] = shade;
      }
      
      // Create new frame out of processed buffer
      const processedFrame = new VideoFrame(buffer, {
        format: frame.format,
        codedWidth: frame.codedWidth,
        codedHeight: frame.codedHeight,
        timestamp: frame.timestamp,
        duration: frame.duration,
        visibleRect: frame.visibleRect,
        displayWidth: frame.displayWidth,
        displayHeight: frame.displayHeight,
        colorSpace: frame.colorSpace
      });

      // Time to get rid of the incoming VideoFrame and to return the newly
      // created one.
      frame.close();
      controller.enqueue(processedFrame);
    }
  };
}