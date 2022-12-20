'use strict';

/**
 * Worker that takes a stream of VideoFrame as input and applies requested
 * transformations to it.
 * 
 * Currently available transformations are very basic: delays or H.264
 * encode/decode. H.264 encode/decode was typically adapted from:
 * https://github.com/w3c/webcodecs/pull/583
 * (although note the code does not queue frames onto the
 * VideoEncoder/VideoDecoder but rather relies on streams to handle queueing
 * and backpressure)
 */

importScripts('InstrumentedTransformStream.js');

let started = false;
let encoder;
let decoder;

// TEMP: workaround Chrome failure to close VideoFrames in workers
// when they are transferred to the main thread.
// Drop whenever possible!
const framesToClose = {};

function rnd(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min);
}

self.addEventListener('message', async function(e) {
  if (e.data.type === 'start') {
    InstrumentedTransformStream.resetStats();
    const inputStream = e.data.streams.input;
    const outputStream = e.data.streams.output;
    const config = e.data.config;
    const transformMode = config.transformMode || 'identity';
    const encodeMode = config.encodeMode || 'none';
    const encodeConfig = config.encodeConfig;
    const frameRate = config.frameRate || 25;
    const frameDuration = Math.round(1000 / frameRate);

    let previousTimestamp = 0;
    const generateOutOfOrderFrames = new InstrumentedTransformStream({
      name: transformMode,
      transform(frame, controller) {
        const elapsed = frame.timestamp - previousTimestamp;
        let delay = 0;
        switch (transformMode) {
          case 'outoforder':
            // Move the frame out of order by issuing it
            // later on without interrupting the stream
            if (elapsed > 5 * 1000 * 1000) {
              delay = 4 * frameDuration;
              previousTimestamp = frame.timestamp;
              console.log('frame moved out of order',
                Math.round(frame.timestamp / 1000));
              setTimeout(function () {
                controller.enqueue(frame);
              }, delay);
              return;
            }
            break;

          case 'longer':
            // Make the frame take longer to process
            // while applying backpressure to the stream
            if (elapsed > 2 * 1000 * 1000) {
              delay = Math.round(frameDuration / 3);
              previousTimestamp = frame.timestamp;
              console.log('frame delayed',
                Math.round(frame.timestamp / 1000));
              return new Promise(res => {
                setTimeout(function () {
                  res();
                  controller.enqueue(frame);
                }, delay);
              });
            }
            break;
        }
        // Compute end time before calling enqueue as next TransformStream
        // starts right when enqueue is called
        this.setEndTime(frame.timestamp);
        controller.enqueue(frame);
      }
    });

    const EncodeVideoStream = new InstrumentedTransformStream({
      name: 'encode',
      start(controller) {
        this.encodedCallback = null;
        this.frameCounter = 0;
        this.seqNo = 0;
        this.keyframeIndex = 0;
        this.deltaframeIndex = 0;
        this.encoder = encoder = new VideoEncoder({
          output: (chunk, cfg) => {
            if (cfg.decoderConfig) {
              const decoderConfig = JSON.stringify(cfg.decoderConfig);
              const configChunk =
              {
                type: 'config',
                seqNo: this.seqNo,
                keyframeIndex: this.keyframeIndex,
                deltaframeIndex: this.deltaframeIndex,
                timestamp: 0,
                pt: 0,
                config: decoderConfig 
              };
              controller.enqueue(configChunk); 
            } 
            chunk.temporalLayerId = 0;
            this.seqNo++;
            if (chunk.type == 'key') {
              this.keyframeIndex++;
              this.deltaframeIndex = 0;
            } else {
              this.deltaframeIndex++;
            } 
            chunk.seqNo = this.seqNo;
            chunk.keyframeIndex = this.keyframeIndex;
            chunk.deltaframeIndex = this.deltaframeIndex;
            if (this.encodedCallback) {
              this.encodedCallback();
              this.encodedCallback = null;
            }
            controller.enqueue(chunk);
          },
          error: e => {
            console.error(e);
          }
        });
        VideoEncoder.isConfigSupported(encodeConfig)
          .then(encoderSupport => {
            if (encoderSupport.supported) {
              this.encoder.configure(encoderSupport.config);
            }
            else {
              console.warn('encode config not supported');
            }
          })
          .catch(e => {
            console.error(e);
          });
      },

      transform(frame, controller) {
        if (this.encoder.state === 'closed') {
          frame.close();
          return;
        }

        return new Promise(resolve => {
          this.encodedCallback = resolve;
          const insert_keyframe = (this.frameCounter % config.keyInterval) == 0;
          this.frameCounter++;
          this.encoder.encode(frame, { keyFrame: insert_keyframe });
          frame.close();
        });
      }
    });


    const DecodeVideoStream = new InstrumentedTransformStream({
      name: 'decode',
      start(controller) {
        this.decodedCallback = null;
        this.decoder = decoder = new VideoDecoder({
          output: frame => {
            if (this.decodedCallback) {
              this.decodedCallback();
              this.decodedCallback = null;
            }
            controller.enqueue(frame);
          },
          error: e => {
            console.error(e)
          }
        });
      },
      transform(chunk, controller) {
        if (this.decoder.state === 'closed') {
          return;
        }
        if (chunk.type === 'config') {
          let config = JSON.parse(chunk.config);
          return VideoDecoder.isConfigSupported(config)
            .then(decoderSupport => {
              if (decoderSupport.supported) {
                this.decoder.configure(decoderSupport.config);
              }
              else {
                console.error('Decoder config not supported', decoderSupport.config);
              }
            });
        }
        else {
          return new Promise(resolve => {
            this.decodedCallback = resolve;
            this.decoder.decode(chunk);
          });
        }
      }
    });

    let intermediaryStream;

    switch (transformMode) {
      case 'identity':
        intermediaryStream = inputStream;
        break;
      case 'outoforder':
      case 'longer':
        intermediaryStream = inputStream.pipeThrough(generateOutOfOrderFrames);
        break;
    }

    switch (encodeMode) {
      case 'none':
        break;
      case 'H264':
        intermediaryStream = intermediaryStream
          .pipeThrough(EncodeVideoStream)
          .pipeThrough(DecodeVideoStream);
        break;
    }

    intermediaryStream
      // TEMP: workaround Chrome failure to close VideoFrames in workers
      // when they are transferred to the main thread.
      // Drop whenever possible!
      .pipeThrough(new TransformStream({
        transform(frame, controller) {
          if (config.closeHack) {
            framesToClose[frame.timestamp] = frame;
          }
          controller.enqueue(frame);
        }
      }))
      .pipeTo(outputStream);
  }
  else if (e.data.type === 'stop') {
    const stats = InstrumentedTransformStream.collectStats();
    InstrumentedTransformStream.resetStats();
    self.postMessage({ type: 'stats', stats });
    if (encoder) {
      encoder.close();
      encoder = null;
    }
    if (decoder) {
      decoder.close();
      decoder = null;
    }
  }
  // TEMP: workaround Chrome failure to close VideoFrames in workers
  // when they are transferred to the main thread.
  // Drop whenever possible!
  else if (e.data.type === 'closeframe') {
    const frame = framesToClose[e.data.timestamp];
    if (frame) {
      frame.close();
      delete framesToClose[e.data.timestamp];
    }
  }
});