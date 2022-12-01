'use strict';

// TEMP: workaround Chrome failure to close VideoFrames in workers
// when they are transferred to the main thread.
// Drop whenever possible!
const framesToClose = {};

const width = 1920;
const height = 1080;

const hdConstraints = {
  video: { width: 1280, height: 720 }
};

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

function framestats_report(frameTimes, workerTimes) {
  function array_report(durations) {
    durations = durations.slice().sort();
    const count = durations.length;
    const sum = durations.reduce((sum, duration) => sum + duration, 0);
    const half = count >> 1;
    const median = Math.round(count % 2 === 1 ? durations[half] : (durations[half - 1] + durations[half]) / 2);
    return {
      count,
      min: Math.round(Math.min(...durations)),
      max: Math.round(Math.max(...durations)),
      avg: Math.round(sum / count),
      median
    };
  }

  function getDurations(stats, finalStep, startingStep) {
    startingStep = startingStep ?? finalStep;
    return stats
      .filter(s => s[finalStep]?.end && s[startingStep]?.start)
      .map(s => s[finalStep].end - s[startingStep].start);
  }

  function getQueuedDuration(stats) {
    const times = Object.values(stats)
      .filter(v => v?.start)
      .sort((times1, times2) => times1.start - times2.start);
    return times.slice(0, -1)
      .map((s, idx) => times[idx + 1].start - s.end)
      .reduce((curr, total) => total += curr, 0);
  }

  // Compute approximative time during which each frame was displayed
  frameTimes.slice(0, -1).forEach((f, idx) => {
    f.displayDuration = frameTimes[idx + 1].expectedDisplayTime - f.expectedDisplayTime;
  });

  // Collect stats from main thread
  const all = InstrumentedTransformStream.collectStats();
  InstrumentedTransformStream.resetStats();

  // Complete stats with worker stats and display stats
  all.forEach(s => {
    Object.values(workerTimes).forEach(wt => {
      const wStats = wt.find(w => w.ts === s.ts);
      if (wStats) {
        Object.assign(s, wStats);
      }
    });

    const fTimes = frameTimes.find(f => f.ts === Math.floor(s.ts / 1000));
    if (fTimes) {
      s.expectedDisplayTime = fTimes.expectedDisplayTime;
      s.displayDuration = fTimes.displayDuration;
    }
  });

  const displayDiff = frameTimes.slice(0, -1)
    .map(f => f.displayDuration)
    .filter(dur => dur > 0);

  const outoforder = frameTimes
    .filter((f, idx) => idx > 0 && frameTimes[idx - 1].ts > f.ts);

  const res = {
    all,
    durations: all.map(s => {
      return {
        ts: s.ts,
        end2end: Math.round(s.final?.end - s.input?.start),
        overlay: s.overlay ? Math.round(s.overlay.end - s.overlay.start) : 0,
        encoding: s.encode ? Math.round(s.encode.end - s.encode.start) : 0,
        decoding: s.decode ? Math.round(s.decode.end - s.decode.start) : 0,
        outoforder: s.outoforder ? Math.round(s.outoforder.end - s.outoforder.start) : 0,
        longer: s.longer ? Math.round(s.longer.end - s.longer.start) : 0,
        display: Math.round(s.displayDuration),
        queued: getQueuedDuration(s)
      };
    }),
    stats: {
      end2end: array_report(getDurations(all, 'final', 'input')),
      overlay: array_report(getDurations(all, 'overlay')),
      encoding: array_report(getDurations(all, 'encode')),
      decoding: array_report(getDurations(all, 'decode')),
      outoforder: array_report(getDurations(all, 'outoforder')),
      longer: array_report(getDurations(all, 'longer')),
      display: array_report(displayDiff),
      queued: array_report(all.map(getQueuedDuration))
    },
    outoforder
  };

  return res;
}

document.addEventListener('DOMContentLoaded', async function (event) {
  let running = false;
  let inputTrack;
  let frameTimes = [];
  let reportedStats = {};

  const startButton = document.getElementById('start');
  const stopButton = document.getElementById('stop');
  const paramsSection = document.getElementById('params');
  const video = document.getElementById('outputVideo');

  // Retrieve W3C icon and create an ImageBitmap out of it
  const img = new Image(288, 192);
  let icon;
  img.src = 'w3c.svg';
  img.addEventListener('load', async _ => {
    icon = await createImageBitmap(img);
  });

  startButton.disabled = false;
  stopButton.disabled = true;
  paramsSection.hidden = false;
  video.hidden = true;

  const inputWorker = new Worker('worker-getinputstream.js');
  const overlayWorker = new Worker('worker-overlay.js');
  overlayWorker.addEventListener('message', e => {
    if (e.data.type === 'stats') {
      reportedStats.overlayWorker = e.data.stats;
      if (reportedStats.transformWorker) {
        const stats = framestats_report(frameTimes, reportedStats);
        console.log(stats);
      }
    }
  });

  const transformWorker = new Worker('worker-transform.js');
  transformWorker.addEventListener('message', e => {
    if (e.data.type === 'stats') {
      reportedStats.transformWorker = e.data.stats;
      if (reportedStats.overlayWorker) {
        const stats = framestats_report(frameTimes, reportedStats);
        console.log(stats);
      }
    }
  });

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
  });

  async function startMedia() {
    // Reset stats
    InstrumentedTransformStream.resetStats();
    frameTimes = [];
    reportedStats = {};

    // What input stream should we use as input?
    const streamModeEl = document.querySelector('input[name="streammode"]:checked');
    const streamMode = streamModeEl?.value || 'generated';

    // Get the requested frame rate
    const frameRate = parseInt(document.getElementById('framerate').value, 10);

    // Overlay mode
    const overlayModeEl = document.querySelector('input[name="overlay"]:checked');
    const overlayMode = overlayModeEl?.value || 'none';

    // Encoding/Decoding mode
    const encodeModeEl = document.querySelector('input[name="encodemode"]:checked');
    const encodeMode = encodeModeEl?.value || 'none';

    // TEMP: Enable/Disable VideoFrame close hack
    const closeHack = !!document.getElementById('closehack').checked;

    let encodeConfig;
    switch (encodeMode) {
      case 'none':
      case 'H264':
        encodeConfig = {
          alpha: 'discard',
          latencyMode: 'realtime',
          bitrateMode: 'variable',
          codec: 'H264',
          width,
          height,
          bitrate: 1000000, 
          framerate: frameRate,
          keyInterval: 300,
          codec: 'avc1.42002A',
          avc: { format: 'annexb' },
          pt: 1
        };
    }

    // Get the requested transformation mode
    const transformMode = document.querySelector('input[name="mode"]:checked')?.value;

    const config = {
      streamMode,
      encodeMode,
      transformMode,
      overlayMode,
      colors,
      width,
      height,
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
        // Compute end time before calling enqueue as next TransformStream
        // starts right when enqueue is called
        this.setEndTime(frame.timestamp);
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
      const constraints = JSON.parse(JSON.stringify(hdConstraints));
      constraints.video.frameRate = frameRate;
      const mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
      inputTrack = mediaStream.getVideoTracks()[0];
      console.log(inputTrack.getSettings());
      const processor = new MediaStreamTrackProcessor({ track: inputTrack });
      processor.readable.pipeTo(inputTransform.writable);
    }

    let inputStream;
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
          input: inputTransform.readable,
          output: overlayTransform.writable
        }
      }, [inputTransform.readable, overlayTransform.writable]);
      inputStream = overlayTransform.readable;
    }
    else {
      // No overlay requested
      inputStream = inputTransform.readable;
    }

    // TEMP: workaround Chrome failure to close VideoFrames in workers
    // when they are transferred to the main thread.
    // Drop whenever possible!
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
            inputFrame.close();
            delete framesToClose[frame.timestamp];
          }
        }
        this.setEndTime(frame.timestamp);
        controller.enqueue(frame);
      }
    });

    transformWorker.postMessage({
      type: 'start',
      config,
      streams: {
        input: inputStream,
        output: closeTransform.writable
      }
    }, [inputStream, closeTransform.writable]);

    // The transform worker will create another stream of VideoFrames,
    // which we'll convert to a MediaStreamTrack for rendering onto the
    // video element.
    const outputFramesToTrack = new MediaStreamTrackGenerator({ kind: 'video' });
    closeTransform.readable.pipeTo(outputFramesToTrack.writable);

    video.srcObject = new MediaStream([outputFramesToTrack]);

    // Read back the contents of the video element onto a canvas
    const outputCanvas = new OffscreenCanvas(width, height);
    const outputCtx = outputCanvas.getContext('2d',
      { alpha: false, willReadFrequently: true });

    let prevPresentedFrames = 0;
    function processFrame(ts, { presentedFrames, expectedDisplayTime }) {
      if (!running) return;
      if (presentedFrames && presentedFrames > prevPresentedFrames + 1) {
        let missed = presentedFrames - prevPresentedFrames - 1;
        console.log('missed frame sent to compositor',
          '| sent:', presentedFrames,
          '| missed:', missed);
        while (missed) {
          // Record missed frames
          frameTimes.push({
            timestamp: -1,
            expectedDisplayTime
          });
          missed--;
        }
      }
      prevPresentedFrames = presentedFrames;
      if (video.currentTime > 0 && overlayMode === 'timestamp') {
        // We're only interested by the bottom right part of the video
        // where the encoded timestamp is
        const w = video.videoWidth;
        const h = video.videoHeight;
        outputCtx.drawImage(video,
          w / 2, h / 2, w / 2, h / 2, // Bottom right part of the video
          0, 0, w / 2, h / 2);        // Top left part of the canvas

        // Average colors near the center of each quadrant
        const coordinates = [
          { x: w * 1 / 8 - 5, y: h * 1 / 8 - 5 },
          { x: w * 3 / 8 - 5, y: h * 1 / 8 - 5 },
          { x: w * 1 / 8 - 5, y: h * 3 / 8 - 5 },
          { x: w * 3 / 8 - 5, y: h * 3 / 8 - 5 }
        ];
        const pixels = coordinates
          .map(point => outputCtx.getImageData(point.x, point.y, 10, 10).data)
          .map(pixels => {
            return pixels.reduce((total, curr, idx) => {
              const tidx = idx % 4;
              total[tidx] += curr;
              return total;
            }, [0, 0, 0, 0]);
          })
          .map(total => total.map(c => Math.round(c / 100)));

        const frameIndex = colorsToTimestamp(pixels);
        if (frameTimes.find(f => f.ts === frameIndex)) {
          console.log('color decoding issue', frameIndex, pixels);
        }
        frameTimes.push({
          ts: frameIndex,
          expectedDisplayTime
        });
      }

      video.requestVideoFrameCallback(processFrame);
    }
    video.requestVideoFrameCallback(processFrame);
  }
}, false);