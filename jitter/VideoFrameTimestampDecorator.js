'use strict';

importScripts('InstrumentedTransformStream.js');

/**
 * A type of TransformStream that can process a stream of VideoFrames to
 * overlay its timestamp (in milliseconds) using a color code in the bottom
 * right corner of the frame.
 */
class VideoFrameTimestampDecorator extends InstrumentedTransformStream {
  /**
   * Constructor takes config object, basically only needed to get the list of
   * colors to use to encode the timestamp.
   */
  constructor(name, config) {
    // Helper function to convert an hexadecimal color into 4 color components
    // (note GPUs love float numbers between 0.0 and 1.0, including for colors)
    function rgbToBytes(rgb) {
      return [
        parseInt(rgb.slice(1,3), 16), // Red component
        parseInt(rgb.slice(3,5), 16), // Green component
        parseInt(rgb.slice(5,7), 16), // Blue component
        255                           // Alpha component
      ].map(c => c / 255);            // Convert to floats from 0.0 to 1.0
    }

    function pad(n, width) {
      return n.length >= width ? n : '0' + pad(n, width-1);
    }

    function timestampToColors(idx) {
      const str = pad(Number(idx).toString(colorBytes.length), 4);
      const digits = Array.from(str).map(char => parseInt(char, colorBytes.length));
      return digits.map(d => colorBytes[d]);
    }

    // Internal variables used to set things up for WebGPU and keep track of
    // the setup so that the "transform" function can use it.
    let gpuDevice;
    let fragmentBindGroupLayout;
    let gpuPipeline;
    let textureSampler;

    // Convert hexadecimal rgb colors to GPU-friendly colors once and for all
    const colorBytes = config.colors.map(rgbToBytes);

    // Create canvas onto which we'll render
    const canvas = new OffscreenCanvas(
      config?.width ?? 1920,
      config?.height ?? 1080
    );
    const gpuCanvasContext = canvas.getContext('webgpu');

    super({
      name,

      /**
       * Initialize the WebGPU context
       */
      async start(controller) {
        // Initialize WebGPU and the canvas that we'll draw to.
        // This is boilerplate code with default parameters.
        const adapter = await navigator.gpu.requestAdapter();
        gpuDevice = await adapter.requestDevice();
        const format = navigator.gpu.getPreferredCanvasFormat();
        gpuCanvasContext.configure({
          device: gpuDevice,
          format: format,
          alphaMode: 'opaque',
        });

        // Not quite sure why the bind group layout needs to be created
        // explicitly, as opposed to using the implicit one returned by
        // "getBindGroupLayout" but that seems needed for the buffer param (the
        // layout returned by "getBindGroupLayout" has 4 bindings instead of 3).
        // Implicit vs. explicit seems to be a common source of confusion for
        // beginners, see: https://github.com/gpuweb/gpuweb/issues/2470
        fragmentBindGroupLayout = gpuDevice.createBindGroupLayout({
          entries: [
            { binding: 0, visibility: GPUShaderStage.FRAGMENT, sampler: {} },
            { binding: 1, visibility: GPUShaderStage.FRAGMENT, externalTexture: {} },
            { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
          ]
        })

        // Define the GPU render pipeline which, as all render pipelines,
        // consists of a vertex shader that returns a list of triangles (2
        // triangles that cover the whole canvas in our case) and a fragment
        // shader that computes the color of each point in these triangles.
        // The WGSL source of the shaders is at the end of this file.
        gpuPipeline = gpuDevice.createRenderPipeline({
          layout: gpuDevice.createPipelineLayout({
            bindGroupLayouts: [
              fragmentBindGroupLayout
            ]
          }),
          vertex: {
            module: gpuDevice.createShaderModule({
              code: VideoFrameTimestampDecorator.#vertexShaderSource
            }),
            entryPoint: 'vert_main'
          },
          fragment: {
            module: gpuDevice.createShaderModule({
              code: VideoFrameTimestampDecorator.#fragmentShaderSource
            }),
            entryPoint: 'frag_main',
            targets: [
              { format: format }
            ]
          },
          primitive: {
            topology: 'triangle-list'
          }
        });

        // Use default sampler configuration to sample the texture and get the
        // color to use to render a particular pixel from it.
        textureSampler = gpuDevice.createSampler({});
      },


      /**
       * Process a new frame on the GPU to overlay the timestamp on top of the
       * frame, and return a new VideoFrame with the result.
       * 
       * To process the new frame, colors to use to encode the timestamp need
       * to be sent to the GPU through a GPUBuffer.
       */
      transform(frame, controller) {
        // Adjust the size of the canvas to the size of the frame to process
        // (In our case, all frames should have the same size so this is not
        // really needed)
        canvas.width = frame.displayWidth;
        canvas.height = frame.displayHeight;

        // Save the frame's timestamp
        const timestamp = frame.timestamp;

        // Prepare the GPUBuffer that will contain the colors sent to the GPU.
        // Note we can only encode reasonable numbers so timestamp gets
        // converted to milliseconds.
        const colorsBuffer = gpuDevice.createBuffer({
          size: 4 * 4 * 4,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
          mappedAtCreation: true
        });
        const map = new Float32Array(colorsBuffer.getMappedRange());
        map.set(timestampToColors(Math.floor(timestamp / 1000)).flat(), 0);
        colorsBuffer.unmap();

        // Create the binding group with the sample, the texture and the params
        const uniformBindGroup = gpuDevice.createBindGroup({
          layout: fragmentBindGroupLayout,
          entries: [
            { binding: 0, resource: textureSampler },
            { binding: 1, resource: gpuDevice.importExternalTexture({source: frame}) },
            { binding: 2, resource: { buffer: colorsBuffer } }
          ],
        });

        // The rest is pretty much boilerplate to prepare, queue and run draw
        // commands on the GPU. 6 draws are needed, 3 per triangle.
        // (Note the draw commands are for the vertex shader, the fragment
        // shader gets called with interpolated coordinates for each pixel
        // in the triangles, in other words ore than a million of times per
        // frame).
        const commandEncoder = gpuDevice.createCommandEncoder();
        const textureView = gpuCanvasContext.getCurrentTexture().createView();
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
        passEncoder.setPipeline(gpuPipeline);
        passEncoder.setBindGroup(0, uniformBindGroup);
        passEncoder.draw(6, 1, 0, 0);
        passEncoder.end();
        gpuDevice.queue.submit([commandEncoder.finish()]);

        // The frame was sent to the GPU as external texture, no need to keep the
        // VideoFrame object open any longer in this CPU worker.
        frame.close();

        // Wait for GPU processing to be done, create and enqueue a VideoFrame
        // out of the the resulting canvas and compute the overall time spent
        // in the TransformStream.
        return gpuDevice.queue
          .onSubmittedWorkDone()
          .then(_ => {
            const frame = new VideoFrame(canvas, {
              timestamp: timestamp,
              alpha: 'discard'
            });
            this.setEndTime(timestamp);
            controller.enqueue(frame);
          });
      }
    });
  }


  /**
   * Vertex shader:
   * Receives the vertex index as parameter, from 0 to 5. Vertices 0, 1, 2
   * create the bottom-right triangle. Vertices 3, 4, 5 create the top-left
   * triangle. The two triangles cover the whole canvas.
   *
   * Note uv coordinates are from 0.0 to 1.0, from top left to bottom right,
   * whereas pos coordinates follow the clip space from -1.0 to 1.0, from
   * bottom left to top right. The uv coordinates are more convenient to deal
   * with because they match those used in video frames.
   */
  static #vertexShaderSource = `
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


  /**
   * Fragment shader:
   * Receives the uv coordinates of the pixel to render as parameter.
   *
   * Expects a sampler, used to get pixels out of a texture, an external texture
   * that represents the frame to draw, and the four colors to use to encode the
   * digits of the timestamp, to be set in what GPU specs call a binding group.
   * The parameters structure is a "uniform" because the variable is to hold
   * the same value for all calls of the fragment shader.
   *
   * The fragment shader could compute the colors itself but that would be a
   * waste of time: the computation is needed for ~250 000 pixels and the
   * computation is the same for all of these pixels!
   *
   * The shader returns the color of the pixel to render, which is either the
   * color of the corresponding pixel in the video frame, or a color that
   * encodes one of the digits of the frame's timestamp (in base "number of
   * colors") when the pixel is in the bottom right corner of the canvas.
   */
  static #fragmentShaderSource = `
    @group(0) @binding(0) var mySampler: sampler;
    @group(0) @binding(1) var myTexture: texture_external;
    @group(0) @binding(2) var<uniform> tsColors: array<vec4<f32>,4>;

    // The main function of the fragment shader
    @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
      if (uv.x > 0.5 && uv.y > 0.5) {
        let xcomp: f32 = (1 + sign(uv.x - 0.75)) / 2;
        let ycomp: f32 = (1 + sign(uv.y - 0.75)) / 2;
        let idx: u32 = u32(sign(xcomp) + 2 * sign(ycomp));
        return tsColors[idx];
      }
      else {
        return textureSampleLevel(myTexture, mySampler, uv);
      }
    }
  `;
}