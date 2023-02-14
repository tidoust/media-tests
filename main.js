'use strict';

// TEMP: VideoFrames sent through a TransformStream are serialized (and thus
// cloned) and not transferred for now. This means that they need to be closed
// on both ends, in particular when TransformStream sits across workers.
// Unfortunately, they cannot be closed right away on the sender's end because
// the receiver may not yet have received them. Workaround is to close them at
// the end of the processing.
// For additional context, see https://github.com/whatwg/streams/issues/1187
const framesToClose = {};


/**
 * Possible video resolutions
 */
const resolutions = {
  '360p':  { width: 640,  height: 360 },
  '480p':  { width: 640,  height: 480 },
  '720p':  { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  '2160p': { width: 3840, height: 2160 }
};


/**
 * A set of colors used to encode the frame's timestamp in an overlay, and
 * companion function to decode a timestamp from a set of pixels.
 */
const colors = [
  '#000000',
  '#500000', '#A00000', '#F00000',
  '#005000', '#00A000', '#00F000',
  '#000050', '#0000A0', '#0000F0',
  '#505000', '#50A000', '#50F000',
  '#500050', '#5000A0', '#5000F0',
  '#A05000', '#A0A000', '#A0F000',
  '#A00050', '#A000A0', '#A000F0',
  '#F05000', '#F0A000', '#F0F000',
  '#F00050', '#F000A0', '#F000F0',
  '#505050', '#5050A0', '#5050F0',
  '#A05050', '#A050A0', '#A050F0'
];
const colorBytes = colors.map(rgbToBytes);

function rgbToBytes(rgb) {
  return [
    parseInt(rgb.slice(1,3), 16),
    parseInt(rgb.slice(3,5), 16),
    parseInt(rgb.slice(5,7), 16),
    255
  ];
}

function colorsToTimestamp(pixels) {
  const digits = pixels.map(pixel =>
    colorBytes.findIndex(c => c.every((t, i) => Math.abs(t - pixel[i]) < 32)));
  const str = digits.map(d => d.toString(colors.length)).join('');
  const frameIndex = parseInt(str, colors.length);
  return frameIndex;
}


document.addEventListener('DOMContentLoaded', async function (event) {
  let running = false;
  let inputTrack;
  let timesDB = new StepTimesDB({ initialStep: 'input', finalStep: 'final' });
  let reportedStats = {};
  let rvfcHandle;

  const startButton = document.getElementById('start');
  const stopButton = document.getElementById('stop');
  const paramsSection = document.getElementById('params');
  const video = document.getElementById('outputVideo');

  startButton.disabled = false;
  stopButton.disabled = true;
  paramsSection.hidden = false;
  video.hidden = true;

  // Retrieve W3C icon and create an ImageBitmap out of it.
  // The W3C icon will be embedded in the stream of VideoFrames produced in
  // worker-getinputstream.js. That step cannot be done in the worker though
  // because browsers typically do not support creating an ImageBitmap out of
  // an SVG image in workers.
  const img = new Image(288, 192);
  let icon;
  img.src = 'w3c.svg';
  img.addEventListener('load', async _ => {
    icon = await createImageBitmap(img);
  });

  function reportStats() {
    const mainStats = InstrumentedTransformStream.collectStats();
    timesDB.addEntries(mainStats);
    if (reportedStats.transformWorker) {
      timesDB.addEntries(reportedStats.transformWorker);
    }
    if (reportedStats.overlayWorker) {
      timesDB.addEntries(reportedStats.overlayWorker);
    }
    const report = timesDB.computeStats();
    console.log(report);
  }

  // Initialize workers:
  // 1. a worker that can produce a stream of VideoFrames from scratch
  // 2. a worker that can add an overlay to a stream of VideoFrames
  // 3. a worker that can apply transforms to a stream of VideoFrames
  const inputWorker = new Worker('worker-getinputstream.js');
  const overlayWorker = new Worker('worker-overlay.js');
  overlayWorker.addEventListener('message', e => {
    if (e.data.type === 'stats') {
      reportedStats.overlayWorker = e.data.stats;
      if (reportedStats.transformWorker) {
        reportStats();
      }
    }
  });

  const transformWorker = new Worker('worker-transform.js');
  transformWorker.addEventListener('message', e => {
    if (e.data.type === 'stats') {
      reportedStats.transformWorker = e.data.stats;
      if (reportedStats.overlayWorker) {
        reportStats();
      }
    }
  });

  // React to user action on "start" and "stop" buttons
  startButton.addEventListener('click', _ => {
    running = true;
    startButton.disabled = true;
    stopButton.disabled = false;
    paramsSection.hidden = true;
    video.hidden = false;
    startMedia();
  });

  stopButton.addEventListener('click', _ => {
    running = false;
    stopButton.disabled = true;
    startButton.disabled = false;
    paramsSection.hidden = false;
    video.hidden = true;
    if (inputTrack) {
      inputTrack.stop();
      inputTrack = null;
    }
    inputWorker.postMessage({ type: 'stop' });
    overlayWorker.postMessage({ type: 'stop' });
    transformWorker.postMessage({ type: 'stop' });
    if (rvfcHandle) {
      video.cancelVideoFrameCallback(rvfcHandle);
      rvfcHandle = null;
    }
  });

  async function startMedia() {
    // Reset stats
    timesDB.reset();
    InstrumentedTransformStream.resetStats();
    reportedStats = {};
    let missedCounter = 0;

    // What stream should we use as input?
    const streamModeEl = document.querySelector('input[name="streammode"]:checked');
    const streamMode = streamModeEl?.value || 'generated';

    // Get the requested video frame resolution
    let resolution;
    const requestedResolution = document.getElementById('resolution').value;
    if (requestedResolution === 'default') {
      if (streamMode === 'generated') {
        resolution = resolutions['1080p'];
      }
      else {
        resolution = resolutions['720p'];
      }
    }
    else {
      resolution = resolutions[requestedResolution];
    }
    resolution = JSON.parse(JSON.stringify(resolution));

    // Get the requested frame rate
    const frameRate = parseInt(document.getElementById('framerate').value, 10);

    // Overlay mode
    const overlayModeEl = document.querySelector('input[name="overlay"]:checked');
    const overlayMode = overlayModeEl?.value || 'none';

    // TEMP: Enable/Disable VideoFrame close hack
    const closeHack = !!document.getElementById('closehack').checked;

    // Get the requested transformation modes
    const transformModes = {
      green: !!document.querySelector('input#mode-green:checked'),
      outoforder: !!document.querySelector('input#mode-ooo:checked'),
      longer: !!document.querySelector('input#mode-slow:checked'),
      encode: !!document.querySelector('input#mode-encode:checked')
    };

    let encodeConfig;
    if (transformModes.encode) {
      encodeConfig = {
        alpha: 'discard',
        latencyMode: 'realtime',
        bitrateMode: 'variable',
        codec: 'H264',
        width: resolution.width,
        height: resolution.height,
        bitrate: 1000000,
        framerate: frameRate,
        keyInterval: 300,
        codec: 'avc1.42002A',
        avc: { format: 'annexb' },
        pt: 1
      };
    }

    const config = {
      streamMode,
      transformModes,
      overlayMode,
      colors,
      width: resolution.width,
      height: resolution.height,
      frameRate,
      encodeConfig,
      closeHack
    };

    // The "input" step is the first time at which we see the VideoFrame. The
    // instrumented TransformStream allows us to capture that start time
    // (the transform in itself should basically take 0ms)
    const inputTransform = new InstrumentedTransformStream({
      name: 'input',
      transform(frame, controller) {
        if (closeHack) {
          framesToClose[frame.timestamp] = frame;
        }
        controller.enqueue(frame);
      }
    });

    if (streamMode === 'generated') {
      // Generate a stream of VideoFrames in a dedicated worker and pass the
      // result as input to the "input" TransformStream
      inputWorker.postMessage({
        type: 'start',
        config: Object.assign({ icon }, config),
        stream: inputTransform.writable
      }, [inputTransform.writable]);
    }
    else {
      // Generate a MediaStreamTrack from the camera and pass the result in a
      // MediaStreamTrackProcess to generate a stream of VideoFrames that can
      // be fed as input to the "input" TransformStream
      const constraints = { video: resolution };
      constraints.video.frameRate = frameRate;
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      inputTrack = mediaStream.getVideoTracks()[0];
      console.log(inputTrack.getSettings());
      const processor = new MediaStreamTrackProcessor({ track: inputTrack });
      processor.readable.pipeTo(inputTransform.writable);
    }

    let stream = inputTransform.readable;

    const identityTransform = new TransformStream({
      transform(frame, controller) {
          if (closeHack) {
            // The transform creates another VideoFrame from the first one.
            // Chromium does not properly close the frame, so let's do that now
            // and track the new VideoFrame from now on.
            if (framesToClose[frame.timestamp]) {
              framesToClose[frame.timestamp].close();
            }
            framesToClose[frame.timestamp] = frame;
          }
          controller.enqueue(frame);
        }
    });
    transformWorker.postMessage({
      type: 'start',
      config,
      streams: {
        input: stream,
        output: identityTransform.writable
      }
    }, [stream, identityTransform.writable]);
    stream = identityTransform.readable;

    if (overlayMode === 'timestamp') {
      const overlayTransform = new TransformStream({
        transform(frame, controller) {
          if (closeHack) {
            // The overlay creates another VideoFrame from the first one.
            // Chromium does not properly close the frame, so let's do that now
            // and track the new VideoFrame from now on.
            if (framesToClose[frame.timestamp]) {
              framesToClose[frame.timestamp].close();
            }
            framesToClose[frame.timestamp] = frame;
          }
          controller.enqueue(frame);
        }
      });
      overlayWorker.postMessage({
        type: 'start',
        config,
        streams: {
          input: stream,
          output: overlayTransform.writable
        }
      }, [stream, overlayTransform.writable]);
      stream = overlayTransform.readable;
    }

    // TEMP: VideoFrame close hack
    const closeTransform = new InstrumentedTransformStream({
      name: 'final',
      transform(frame, controller) {
        if (closeHack) {
          if (streamMode === 'generated') {
            inputWorker.postMessage({
              type: 'closeframe',
              timestamp: frame.timestamp
            });
          }
          if (overlayMode !== 'none') {
            overlayWorker.postMessage({
              type: 'closeframe',
              timestamp: frame.timestamp
            });
          }
          transformWorker.postMessage({
            type: 'closeframe',
            timestamp: frame.timestamp
          });
          const inputFrame = framesToClose[frame.timestamp];
          if (inputFrame) {
            if (inputFrame !== frame) {
              inputFrame.close();
            }
            delete framesToClose[frame.timestamp];
          }
        }
        controller.enqueue(frame);
      }
    });
    stream = stream.pipeThrough(closeTransform);

    // The transform worker will create another stream of VideoFrames,
    // which we'll convert to a MediaStreamTrack for rendering onto the
    // video element.
    const outputFramesToTrack = new MediaStreamTrackGenerator({ kind: 'video' });
    stream.pipeTo(outputFramesToTrack.writable);

    video.srcObject = new MediaStream([outputFramesToTrack]);

    // Read back the contents of the video element onto a canvas
    const outputCanvas = new OffscreenCanvas(32, 32);
    const outputCtx = outputCanvas.getContext('2d',
      { alpha: false, willReadFrequently: true });

    let prevPresentedFrames = 0;
    function processFrame(ts, { presentedFrames, expectedDisplayTime, presentationTime }) {
      rvfcHandle = null;
      if (!running) return;
      if (presentedFrames && presentedFrames > prevPresentedFrames + 1) {
        let missed = presentedFrames - prevPresentedFrames - 1;
        console.log('missed frame sent to compositor',
          '| sent:', presentedFrames,
          '| missed:', missed);
        while (missed) {
          // Record missed frames
          timesDB.addEntry({
            id: `missed-${missedCounter++}`,
            display: { start: performance.timeOrigin + expectedDisplayTime }
          });
          missed--;
        }
      }
      if (presentedFrames && presentedFrames === prevPresentedFrames) {
        // Same frame as previous loop, skip it
        return;
      }
      prevPresentedFrames = presentedFrames;
      if (video.currentTime > 0 && overlayMode === 'timestamp') {
        // We're only interested by the bottom right part of the video where the
        // encoded timestamp is (positioned at 3/4 of width and height). Goal is
        // to average colors in each quadrant.
        const w = video.videoWidth;
        const h = video.videoHeight;
        outputCtx.drawImage(video,
          // Copy a block of 32 * 32 pixels from the bottom right part of the
          // video, centered on the intersection of the four quadrants
          w * 7 / 8 - 16, h * 7 / 8 - 16, 32, 32,
          // Copy the block to the top left part of the canvas,
          0, 0, 32, 32);

        // Average colors near the center of each quadrant (avoiding pixels
        // close to the center where encoding/decoding step could perhaps
        // create color artefacts)
        const coordinates = [
          { x: 0, y: 0 },
          { x: 20, y: 0 },
          { x: 0, y: 20 },
          { x: 20, y: 20 }
        ];
        const pixels = coordinates
          .map(point => outputCtx.getImageData(point.x, point.y, 8, 8).data)
          .map(pixels => {
            return pixels.reduce((total, curr, idx) => {
              const tidx = idx % 4;
              total[tidx] += curr;
              return total;
            }, [0, 0, 0, 0]);
          })
          .map(total => total.map(c => Math.round(c / (8*8))));

        const frameIndex = colorsToTimestamp(pixels) * 1000;
        const dupl = timesDB.find(frameIndex);
        if (dupl) {
          console.log(`frame ${frameIndex} seen already`);
        }
        timesDB.addEntry({
          id: frameIndex,
          display: { start: performance.timeOrigin + expectedDisplayTime }
        });
      }

      rvfcHandle = video.requestVideoFrameCallback(processFrame);
    }
    video.requestVideoFrameCallback(processFrame);
  }
}, false);