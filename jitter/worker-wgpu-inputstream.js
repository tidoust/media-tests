'use strict';

// TEMP: workaround Chrome failure to close VideoFrames in workers
// when they are transferred to the main thread.
// Drop whenever possible!
const framesToClose = {};

function rgbToBytes(rgb) {
  return [
    parseInt(rgb.slice(1,3), 16),
    parseInt(rgb.slice(3,5), 16),
    parseInt(rgb.slice(5,7), 16),
    255
  ].map(c => c / 255);
}

// Generates two triangles covering the whole canvas.
const vertexShaderSource = `
  struct VertexOutput {
    @builtin(position) Position: vec4<f32>,
    @location(0) uv: vec2<f32>,
  }

  @vertex
  fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
    var pos = array<vec2<f32>, 6>(
      vec2<f32>( 1.0,  1.0),
      vec2<f32>( 1.0, -1.0),
      vec2<f32>(-1.0, -1.0),
      vec2<f32>( 1.0,  1.0),
      vec2<f32>(-1.0, -1.0),
      vec2<f32>(-1.0,  1.0)
    );

    var uv = array<vec2<f32>, 6>(
      vec2<f32>(1.0, 0.0),
      vec2<f32>(1.0, 1.0),
      vec2<f32>(0.0, 1.0),
      vec2<f32>(1.0, 0.0),
      vec2<f32>(0.0, 1.0),
      vec2<f32>(0.0, 0.0)
    );

    var output : VertexOutput;
    output.Position = vec4<f32>(pos[VertexIndex], 0.0, 1.0);
    output.uv = uv[VertexIndex];
    return output;
  }
`;

// Sample the external texture using generated coordinates
// and overlay the timestamp in the bottom right corner
const fragmentShaderSource = `
  struct Params {
    timestamp: f32,
    nbColors: f32,
    colors: array<vec4<f32>,64>
  }

  @group(0) @binding(0) var mySampler: sampler;
  @group(0) @binding(1) var myTexture: texture_external;
  @group(0) @binding(2) var<uniform> params: Params;

  // Convert number to 4 digits in the given base
  fn nbToDigits(nb: f32, base: f32) -> vec4<u32> {
    let first: u32 = u32(nb % base);
    let firstremainder: f32 = trunc(nb / base);
    let second: u32 = u32(firstremainder % base);
    let secondremainder: f32 = trunc(firstremainder / base);
    let third: u32 = u32(secondremainder % base);
    let thirdremainder: f32 = trunc(secondremainder / base);
    let fourth: u32 = u32(thirdremainder % base);
    return vec4<u32>(fourth, third, second, first);
  }

  fn timestampToColor(ts: f32, index: u32) -> vec4<f32> {
    let digits: vec4<u32> = nbToDigits(ts, params.nbColors);
    let digit: u32 = digits[index];
    let color: vec4<f32> = params.colors[digit];
    return vec4<f32>(color[0], color[1], color[2], 1.0);
  }

  @fragment
  fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
    // TODO: Re-write to avoid "if... then... else..."
    if (uv.x > 0.5 && uv.y > 0.5) {
      if (uv.x > 0.75) {
        if (uv.y > 0.75) {
          return timestampToColor(params.timestamp, 3);
        }
        else {
          return timestampToColor(params.timestamp, 1);
        }
      }
      else {
        if (uv.y > 0.75) {
          return timestampToColor(params.timestamp, 2);
        }
        else {
          return timestampToColor(params.timestamp, 0);
        }
      }
    }
    else {
      return textureSampleLevel(myTexture, mySampler, uv);
    }
  }
`;

self.addEventListener('message', async function(e) {
  if (e.data.type === 'start') {
    const inputStream = e.data.streams.input;
    const outputStream = e.data.streams.output;
    const config = e.data.config;
    const colorBytes = config.colors.map(rgbToBytes).flat();

    const addTimestampToFrame = new TransformStream({
      async start(controller) {
        // Initialize WebGPU and the canvas that we'll draw to
        const adapter = await navigator.gpu.requestAdapter();
        this.device = await adapter.requestDevice();
        this.format = navigator.gpu.getPreferredCanvasFormat();

        this.canvas = new OffscreenCanvas(config.width, config.height);

        this.ctx = this.canvas.getContext('webgpu');
        this.ctx.configure({
          device: this.device,
          format: this.format,
          alphaMode: 'opaque',
        });

        // The fragment shader takes a sampler, an external texture
        // and a buffer that contains the timestamp and the colors to use
        // to encode the timestamp.
        // (Not quite sure why creating an explicit bind group layout is
        // needed, as opposed to using the one returned by getBindGroupLayout
        // but that's needed once a buffer input is used)
        this.fragmentBindGroupLayout = this.device.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          ]
        })

        // Define the render pipeline which, as all render pipelines, consists
        // of a vertex shader and a fragment shader. The vertex shader returns
        // a list of triangles (in practice, 2 triangles that cover the entire
        // canvas)
        this.pipeline = this.device.createRenderPipeline({
          layout: this.device.createPipelineLayout({
            bindGroupLayouts: [ this.fragmentBindGroupLayout ]
          }),
          vertex: {
            module: this.device.createShaderModule({code: vertexShaderSource}),
            entryPoint: 'vert_main'
          },
          fragment: {
            module: this.device.createShaderModule({code: fragmentShaderSource}),
            entryPoint: 'frag_main',
            targets: [{format: this.format}]
          },
          primitive: {
            topology: 'triangle-list'
          }
        });

        // Use default sampler configuration
        this.sampler = this.device.createSampler({});
      },

      transform(frame, controller) {
        this.canvas.width = frame.displayWidth;
        this.canvas.height = frame.displayHeight;

        // For each frame, we need to send a few parameters to the GPU:
        // the frame's timestamp, the colors array to use to encode the
        // timestamp, and then the frame itself as external structure
        // along with the sampler to copy the pixels from the frame.
        const timestamp = frame.timestamp;

        // As apparently everyone should know, the offset of a struct
        // member of type 'array<vec4<u32>, 64>' in address space
        // 'uniform' must be a multiple of 16 bytes. This means we need
        // to leave 8 bytes in the buffer after the first two parameters.
        const paramsBuffer = this.device.createBuffer({
          size: 2 * 4 + 8 + 64 * 4 * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true
        });

        // As noted above, map[2] and map[3] are left for alignment
        const map = new Float32Array(paramsBuffer.getMappedRange());
        map[0] = Math.floor(timestamp / 1000);
        map[1] = config.colors.length;
        map.set(colorBytes, 4);
        paramsBuffer.unmap();

        const uniformBindGroup = this.device.createBindGroup({
          layout: this.fragmentBindGroupLayout,
          entries: [
            { binding: 0, resource: this.sampler },
            { binding: 1, resource: this.device.importExternalTexture({source: frame}) },
            { binding: 2, resource: { buffer: paramsBuffer } }
          ],
        });

        // The rest is pretty much boilerplate to prepare, queue and run
        // draw commands on the GPU. 6 draws are needed, 3 per triangle
        // (note the draw commands are for the vertex shader, the fragment
        // shader gets called with interpolated coordinates for each pixel)
        const commandEncoder = this.device.createCommandEncoder();
        const textureView = this.ctx.getCurrentTexture().createView();
        const renderPassDescriptor = {
          colorAttachments: [
            {
              view: textureView,
              clearValue: [1.0, 0.0, 0.0, 1.0],
              loadOp: 'clear',
              storeOp: 'store',
            },
          ],
        };

        const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
        passEncoder.setPipeline(this.pipeline);
        passEncoder.setBindGroup(0, uniformBindGroup);
        passEncoder.draw(6, 1, 0, 0);
        passEncoder.end();
        this.device.queue.submit([commandEncoder.finish()]);

        frame.close();

        // We'll create a VideoFrame from the resulting canvas
        return this.device.queue
          .onSubmittedWorkDone()
          .then(_ => {
            const frame = new VideoFrame(this.canvas, {
              timestamp: timestamp,
              alpha: 'discard'
            });
            controller.enqueue(frame);
          });
      }
    });

    inputStream
      .pipeThrough(addTimestampToFrame)
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