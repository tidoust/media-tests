# Experimenting with video processing pipelines on the web

This repository contains experimental code to create video processing pipelines using web technologies. It features a semi-generic mechanism to measure the time taken by each processing step.

The code was developed by @dontcallmedom and @tidoust during W3C's Geek Week 2022. It should be viewed as a semi-neophyte attempt to combine recent web technologies to process video, with a view to evaluating how easy or difficult it is to create such processing pipelines. Code here should not be seen as authoritative or even correct. We don't have particular plans to maintain the code either.

See also the [Processing video streams slides](https://www.w3.org/2022/Talks/fd-media-tests/) that present the approach we took and reflect on key outcomes.


## Combined Web technologies

Main web technologies combined are:

- [WebCodecs](https://www.w3.org/TR/webcodecs/) to expose/access actual video frame pixels, through the `VideoFrame`, `VideoEncoder` and `VideoDecoder` interfaces.
- [MediaStreamTrack Insertable Media Processing using Streams](https://www.w3.org/TR/mediacapture-transform/) to connect the WebRTC world with WebCodecs, through the `VideoTrackGenerator` (formerly `MediaStreamTrackGenerator`) and `MediaStreamTrackProcessor` interfaces.
- [WebGPU](https://www.w3.org/TR/webgpu/) and [WGSL](https://www.w3.org/TR/WGSL/) to process frames directly on the GPU.
- [WebAssembly](https://www.w3.org/TR/wasm-core/), also to process frames.
- The [`<canvas>` element](https://html.spec.whatwg.org/multipage/canvas.html#the-canvas-element) and [`OffscreenCanvas`](https://html.spec.whatwg.org/multipage/canvas.html#the-offscreencanvas-interface) to manipulate frame pixels in the background and exchange with WebGPU.
- [Streams](https://streams.spec.whatwg.org/) to create a pipeline with backpressure support through the `ReadableStream`, `WritableStream` and `TransformStream` interfaces.
- The [`<video>` element](https://html.spec.whatwg.org/multipage/media.html#the-video-element) to provide the final rendering step.
- [`HTMLVideoElement.requestVideoFrameCallback()`](https://wicg.github.io/video-rvfc/) to track video frames rendered (or about to be rendered) to a `<video>` element.
- [Web Workers](https://html.spec.whatwg.org/multipage/workers.html#workers) to run processing steps in the background.


## Running the demo

The [demo](https://tidoust.github.io/media-tests/) requires support for the list of technologies mentioned above. Currently, this means using Google Chrome with WebGPU enabled.

The demo lets the user:
- Choose a source of input to create an initial stream of `VideoFrame`: either an animation created from scratch (using `OffscreenCanvas`) or a stream generated from a camera.
- Replace green with W3C blue color using WebAssembly, and/or add an H.264 encoding/decoding transformation stage using WebCodecs, and/or introduce slight delays in the stream using regular JavaScript.
- Add an overlay to the bottom right part of the video that encodes the frame's timestamp. The overlay is added using WebGPU and WGSL.


Timing statistics are reported as objects to the console when the "Stop" button is pressed (this requires opening the dev tools panel). Display times for each frame are reported too when the overlay was present.


## Quick code walkthrough

The code uses `TransformStream` to create processing pipelines. That seemed like the most straightforward mechanism to chain processing steps and benefit from the queueing/backpressure mechanism that comes with streams.

The code features the following files:

- `InstrumentedTransformStream.js`: A drop-in replacement for `TransformStream` that records the time it took to transform a chunk.
- `VideoFrameTimestampDecorator.js`: A transformer that adds an overlay to the bottom right corner of a frame, using WebGPU. Use of WebGPU to create an overlay is certainly not mandatory, it was just an excuse for us to use the technology.
- `GreenBackgroundReplacer.js`: A transformer that replaces green present in the video frame with W3C blue, using WebAssembly. Use of WebAssembly to run this action is also certainly not mandatory (and probably not a good idea in practice), it was again just an excuse for us to use the technology. The transformer references binary WebAssembly code in `GreenBackgroundReplacer.wasm`. That binary code is generated from the WebAssembly code in text format in `GreenBackgroundReplacer.wat`. Code was written using the text format and not one of the many languages that can get transpiled to binary WebAssembly to better understand how WebAssembly works internally. Code was compiled with the [`wat2wasm` package](https://www.npmjs.com/package/wat2wasm), but you may get the same result with the [online `wat2wasm` demo](https://webassembly.github.io/wabt/demo/wat2wasm/).
- `ToRGBXVideoFrameConverter.js`: A transformer that converts a video frame, regardless of its pixel format, to a video frame that uses the `RGBX` format. The transformer uses WebGPU, which is very convenient here because the `GPUSampler` does all the work! This avoids having to handle different formats in the WebAssembly code.
- `worker-getinputstream.js`: A worker that generates a stream of `VideoFrame`.
- `worker-overlay.js`: A worker that leverages `VideoFrameTimestampDecorator` to add the overlay.
- `worker-transform.js`: A worker that can apply transforms to a stream of `VideoFrame`, including green color replacement, H.264 encoding/decoding, and slight alterations of frame delays.
- `StepTimesDB.js`: A generic simple in-memory database to record step processing times of chunks in a stream, and compute stats out of them.
- `main.js`: Main thread logic. The code uses `requestVideoFrameCallback` to inspect rendered frames, copy them to a canvas and decode the color-encoded overlay to retrieve the frame's timestamp (and thus compute the time at which the frame was rendered).


## Struggles / Learnings

Here are some of the things we struggled with, wondered about or learned while developing the code.


### No way to track a frame fed to a `<video>` element

The frame's `timestamp` can be used to track a video frame throughout a processing pipeline. In most scenarios though, the final step is to inject the resulting video into a `<video>` element for playback, and there is no direct way to tell when a specific frame has been rendered by a `<video>` element. [`HTMLVideoElement.requestVideoFrameCallback()`](https://wicg.github.io/video-rvfc/) exposes a number of times that may be used to compute when the underlying frame will be presented to the user, but it does not (yet?) expose the underlying frame's `timestamp` so applications cannot tell which frame is going to be presented.

The code's workaround is to encode the frame's `timestamp` in an overlay and to copy frames rendered to the `<video>` element to a `<canvas>` element whenever the `requestVideoFrameCallback()` callback is called to decode the timestamp. That works so-so because it needs to run on the main thread and `requestVideoFrameCallback()` sometimes misses frames as a result.

Being able to track when a frame is actually rendered seems useful for statistic purpose, e.g. to evaluate jitter effects, and probably for synchronization purpose as well if video needs to be synchronized with some separate audio stream and/or other non-video overlays.

An alternative approach would be to render video frames directly to a `<canvas>` element instead of to a `<video>` element. This means having to re-implement an entire media player in the generic case, which seems a hard problem.


### Hard to mix hybrid stream architectures

The backpressure mechanism in WHATWG Streams takes some getting used to, but appears simple and powerful after a while. It remains difficult to reason about backpressure in video processing pipelines because, by definition, this backpressure mechanism stops whenever something else than WHATWG Streams are used:

- WebRTC uses `MediaStreamTrack` by default.
- The `VideoEncoder` and `VideoDecoder` classes in WebCodecs have their own queueing mechanism.
- `VideoTrackGenerator` and `MediaStreamTrackProcessor` create a bridge between WebRTC and WebCodecs, with specific queueing rules.

There are good reasons that explain the divergence of approaches regarding streams handling across technologies. For example, see [Decoupling WebCodecs from Streams](https://docs.google.com/document/d/10S-p3Ob5snRMjBqpBf5oWn6eYij1vos7cujHoOCCCAw/edit#). From a developer perspective, this makes mixing technologies harder. It also creates more than one way to build the same pipeline with no obvious *right* approach to queueing and backpressure.


### Hard to mix technologies that require dedicated expertise

More generally speaking and not surprisingly, it is hard to mix technologies that require different sets of skills. Examples include: pipeline layouts and memory alignment concepts in WebGPU and WGSL, streams and backpressure, video encoding/decoding parameters, WebAssembly memory layout and instructions. It is also hard to understand when copies are made when technologies are combined. In short, combining technologies creates cognitive load, all the more so than these technologies live in their own ecosystem with somewhat disjoint communities.


### <del>Missing WebGPU / WebCodecs connector?</del> (resolved)

<del>Importing a `VideoFrame` to WebGPU as an external texture is relatively straightforward. To create a `VideoFrame` once GPU processing is over, the code waits for [`onSubmittedWorkDone`](https://www.w3.org/TR/webgpu/#dom-gpuqueue-onsubmittedworkdone) and creates a `VideoFrame` out of the rendered `<canvas>`. In theory at least, the `<canvas>` seems unnecessary but a `VideoFrame` cannot be created out of a `GPUBuffer` (at least without copying the buffer into CPU memory first). Also, this approach seems to create a `~10ms` delay in average and it is not clear whether this is just a temporary implementation hiccup (support for WebGPU and WebCodecs in Chrome are still under development) or just not the right approach to creating a `VideoFrame`. The shaders that create the overlay were clumsily written and can be drastically optimized for sure, but the delay seems to appear even when the shaders merely sample the texture. Is there a more efficient way to read back from WebGPU and hook into further video processing stages?</del>

There is no need to wait for [`onSubmittedWorkDone`](https://www.w3.org/TR/webgpu/#dom-gpuqueue-onsubmittedworkdone) after all. Provided that a `GPUTexture` is attached to the canvas' context, the `VideoFrame` constructor will always read the results of the GPU processing from the canvas (waiting for the processing to complete if needed), see [related discussion in WebGPU repository](https://github.com/gpuweb/gpuweb/issues/3762#issuecomment-1398339650). Doing so makes GPU processing drop to `~1ms` in average.


### VideoFrame and workers

Streams can be transferred to workers. This makes it easy to create processing steps in workers, and transfer streams of `VideoFrame` back and forth between the main thread and workers. Our expectation is that, given a frame, `close()` should only need to be called once, where the `VideoFrame` currently sits. Current implementation of WebCodecs in Chrome seems to lose itself when it transfers a stream of `VideoFrame` across worker boundaries, requiring code to close a `VideoFrame` in all workers where it was transferred to avoid warning messages from the garbage collector or situations where processing freezes because no further `VideoFrame` can be produced. This is implemented as a hack in the code.


### WebAssembly and VideoFrame data copy performances

WebCodecs and other APIs that handle decoded image data were carefully written to avoid exposing the actual image data to the JavaScript code in order to minimize the number of copies that may need to be made. In practice, most processing steps involve data that sits on the GPU: drawing to a canvas, capturing a video stream from a camera, encoding/decoding in H.264, processing with WebGPU.

WebAssembly cannot interact with GPU-bound memory though. The only way to process a `VideoFrame` in WebAssembly is to first copy it over to WebAssembly's linear memory, using `VideoFrame.copyTo()`. That call triggers a *readback from the GPU*, meaning that the frame needs to be copied over from the GPU memory to the `ArrayBuffer` that describes the WebAssembly's linear memory. That copy is costly. A Full HD (1920x1080) SDR video frame in RGBA is `8MB` and copy may take `10-15ms`. That is a significant cost to pay, especially considering that the time budget per frame is only `40ms` for a video at 25 frames per second, and `20ms` for a video at 50 frames per second.

Copy times seem consistent with, albeit a bit higher than, times reported by Paul Adenot in his [Memory Access Patterns in WebCodecs](https://www.w3.org/2021/03/media-production-workshop/talks/paul-adenot-webcodecs-performance.html#intro) talk during W3C's workshop on professional media production on the Web. As [Paul points out](https://www.w3.org/2021/03/media-production-workshop/talks/paul-adenot-webcodecs-performance.html#ts-5), "It's always better to keep the VideoFrames on the GPU if possible". Video frame processing with WebAssembly is possible but not the best option if that processing can be envisioned on the GPU.


### WebGPU and video pixel formats

The arrangement of bytes in each plane of the `VideoFrame` essentially does not matter when WebGPU is used: the `importExternalTexture()` method accepts all common pixel formats and the [`GPUSampler`](https://www.w3.org/TR/webgpu/#gpusampler) takes care of converting these formats under the hoods to create RGBA colors. As such, the shaders don't need to deal with format conversion, they will read RGBA pixels from the incoming video frame texture.

This actually makes use of WebGPU quite convenient to convert a `VideoFrame` whose format is one of the `YUV` variants to an `RGBA` one, as done in `ToRGBXVideoFrameConverter.js`.

One drawback is that it also means that `VideoFrame` that uses one of the `YUV` formats will get converted no matter what. Is there an easy way to preserve the initial `YUV` format using WebGPU?


### WebAssembly and video pixel formats

As opposed to WebGPU, WebAssembly sees the pixels of a `VideoFrame` as a linear sequence of bytes, whose interpretation is up to the WebAssembly code that gets executed. The WebAssembly code thus needs to deal with the different possible variations of `YUV` and `RGB` arrangements... or frame conversion needs to take place before the frame reaches the WebAssembly code. Converting `YUV`-like formats to `RGBA` is relatively straightforward but that is still extra work.


### WebAssembly and bytes arrangement

To speed up WebAssembly processing a bit, it seems useful to read `RGBA` bytes as one 32-bit integer. Beware though, WebAssembly reads memory using little-endian, so when reading the `RGBA` bytes at once, you actually end up with `ABGR` bytes in the 32-bit integer.


### WebAssembly and SIMD

The use of SIMD instructions in WebAssembly could in theory further help divide the processing time by up to 4: SIMD instructions process vectors of 128 bits, meaning 16 color components or 4 pixels at once. This may be worth considering, depending on the processing being applied.


## Acknowledgments

Work on this code was prompted and strongly inspired by demos, code and issues created by Bernard Aboba (@aboba) as part of joint Media Working Group and WebRTC Working Group discussions on the media pipeline architecture, see https://github.com/w3c/media-pipeline-arch/issues/1 and underlying code in https://github.com/w3c/webcodecs/pull/583 for additional context. Many thanks for providing the initial spark and starting code that @dontcallmedom and I could build upon!

WebAssembly code was loosely inspired the [Video manipulation with WebAssembly](https://medium.com/docler-engineering/video-manipulation-with-webassembly-3477a0c8524d) article by Szabolcs Damján.
