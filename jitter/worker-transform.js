'use strict';

let started = false;
let encoder;
let decoder;

function rnd(min, max) {
  min = Math.ceil(min);
  max = Math.floor(max);
  return Math.floor(Math.random() * (max - min) + min);
}

self.addEventListener('message', async function(e) {
  if (e.data.type === 'start') {
    const inputStream = e.data.streams.input;
    const outputStream = e.data.streams.output;
    const config = e.data.config;
    const transformMode = config.transformMode || 'identity';
    const encodeMode = config.encodeMode || 'none';
    const encodeConfig = config.encodeConfig;
    const frameRate = config.frameRate || 25;
    const frameDuration = Math.round(1000 / frameRate);

    let counter = 0;
    const generateOutOfOrderFrames = new TransformStream({
      transform(frame, controller) {
        counter++;
        const frameId = config.streamMode === 'generated' ? frame.timestamp : counter;
        let delay = 0;
        switch (transformMode) {
          case 'outoforder':
            delay = (frameId && frameId % (5 * frameRate) === 0) ?
              4 * frameDuration :
              0;
            break;
          case 'longer':
            delay = (frameId && frameId % (2 * frameRate) === 0) ?
              Math.round(frameDuration / 3) :
              0;
            break;
        }
        if (delay) {
          console.log('delay frame', frameId);
        }
        setTimeout(function () {
          controller.enqueue(frame);
        }, delay);
      }
    });

    const EncodeVideoStream = new TransformStream({
      start(controller) {
        this.pending_outputs = 0;
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
            controller.enqueue(chunk);
            this.pending_outputs--;
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
        if (this.pending_outputs <= 30) {
          this.pending_outputs++;
          const insert_keyframe = (this.frameCounter % config.keyInterval) == 0;
          this.frameCounter++;
          try {
            if (this.encoder.state != "closed") {
              this.encoder.encode(frame, { keyFrame: insert_keyframe });
            } 
          }
          catch(e) {
            console.error(e);
          }
        }
        else {
          console.log('pending_outputs', this.pending_outputs);
        }
        frame.close();
      }
    });


    const DecodeVideoStream = new TransformStream({
      start(controller) {
        this.decoder = decoder = new VideoDecoder({
          output: frame => {
            controller.enqueue(frame);
          },
          error: e => {
            console.error(e)
          }
        });
      },
      transform(chunk, controller) {
        if (this.decoder.state != 'closed') {
          if (chunk.type == 'config') {
            let config = JSON.parse(chunk.config);
            VideoDecoder.isConfigSupported(config).then(decoderSupport => {
              if (decoderSupport.supported) {
                this.decoder.configure(decoderSupport.config);
              }
              else {
                console.error('Decoder config not supported', decoderSupport.config);
              }
            })
            .catch(e => {
              console.error(e);
            })
          }
          else {
            this.decoder.decode(chunk);
          }
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
        intermediaryStream = inputStream.pipeThrough(generateOutOfOrderFrames)
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

    intermediaryStream.pipeTo(outputStream);
  }
  else if (e.data.type === 'stop') {
    if (encoder) {
      encoder.close();
      encoder = null;
    }
    if (decoder) {
      decoder.close();
      decoder = null;
    }
  }
});