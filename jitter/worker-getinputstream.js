'use strict';

function rgbToBytes(rgb) {
  return [
    parseInt(rgb.slice(1,3), 16),
    parseInt(rgb.slice(3,5), 16),
    parseInt(rgb.slice(5,7), 16),
    255
  ];
}

function pad(n, width) {
  return n.length >= width ? n : '0' + pad(n, width-1);
}

let writer;
let intervalId;
let started = false;


self.addEventListener('message', async function (e) {
  if (e.data.type === 'start') {
    if (started) return;
    started = true;

    const colors = e.data.colors;
    const colorBytes = colors.map(rgbToBytes);
    const width = e.data.width;
    const height = e.data.height;
    const frameDuration = e.data.frameDuration || 40;
    const writableStream = e.data.stream;

    // Create the canvas that will help generate an input stream of frames
    // that encode a frame index
    const inputCanvas = new OffscreenCanvas(width, height);
    const inputCtx = inputCanvas.getContext('2d', { alpha: false });

    function timestampToColors(idx) {
      const str = pad(Number(idx).toString(colors.length), 4);
      const digits = Array.from(str).map(char => parseInt(char, colors.length));
      return digits.map(d => colors[d]);
    }

    function timestampToVideoFrame(timestamp) {
      const colors = timestampToColors(timestamp);
      inputCtx.fillStyle = `${colors[0]}`;
      inputCtx.fillRect(0, 0, width / 2, height / 2);
      inputCtx.fillStyle = `${colors[1]}`;
      inputCtx.fillRect(width / 2, 0, width, height / 2);
      inputCtx.fillStyle = `${colors[2]}`;
      inputCtx.fillRect(0, height / 2, width / 2, height);
      inputCtx.fillStyle = `${colors[3]}`;
      inputCtx.fillRect(width / 2, height / 2, width, height);
      return new VideoFrame(inputCanvas, { timestamp, alpha: 'discard' });
    }

    // Write frames into the canvas and generate a stream of VideoFrames
    writer = writableStream.getWriter();

    let timestamp = 0;
    intervalId = setInterval(async () => {
      if (started) {
        await writer.write(timestampToVideoFrame(timestamp));
        timestamp++;
      }
    }, frameDuration);
  }
  else if (e.data.type === 'stop') {
    if (!started) return;
    started = false;
    if (intervalId) {
      clearInterval(intervalId);
      intervalId = null;
    }
    if (writer) {
      writer.abort();
      writer = null;
    }
  }
});