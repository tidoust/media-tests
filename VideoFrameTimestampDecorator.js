'use strict';


/**
 * Returns a transformer for a TransformStream that can process a stream of
 * VideoFrames to overlay its timestamp (in milliseconds) using a color code in
 * the bottom right corner of the frame.
 *
 * The transformer uses WebGPU to create the overlay.
 */
function VideoFrameTimestampDecorator(config) {
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


  /**
   * Fragment shader:
   * Receives the uv coordinates of the pixel to render as parameter.
   * Expects a sampler, used to get pixels out of a texture, an external texture
   * that represents the frame to draw, and a parameters structure with the
   * timestamp to render as overlay, along with the colors to use, to be set in
   * what GPU specs call a binding group.
   * The parameters structure is a "uniform" because the variable is to hold
   * the same value for all calls of the fragment shader.
   * 
   * The shader returns the color of the pixel to render, which is either the
   * color of the corresponding pixel in the video frame, or a color that
   * encodes one of the digits of the frame's timestamp (in base "number of
   * colors") when the pixel is in the bottom right corner of the canvas.
   */
  const fragmentShaderSource = `
    struct Params {
      timestamp: f32,
      nbColors: f32,
      colors: array<vec4<f32>,64>
    }

    @group(0) @binding(0) var mySampler: sampler;
    @group(0) @binding(1) var myTexture: texture_external;
    @group(0) @binding(2) var<uniform> params: Params;

    // Helper function that converts a timestamp to 4 digits representing the
    // timestamp in milliseconds in the given base
    fn nbToDigits(nb: f32, base: f32) -> vec4<u32> {
      let ms = nb / 1000;
      let first: u32 = u32(ms % base);
      let firstremainder: f32 = ms / base;
      let second: u32 = u32(firstremainder % base);
      let secondremainder: f32 = firstremainder / base;
      let third: u32 = u32(secondremainder % base);
      let thirdremainder: f32 = secondremainder / base;
      let fourth: u32 = u32(thirdremainder % base);
      return vec4<u32>(fourth, third, second, first);
    }

    // Helper function that returns the color representing the digit
    // (in base "number of colors") of the timestamp at the given
    // index (from 0 to 3).
    fn timestampToColor(ts: f32, index: u32) -> vec4<f32> {
      let digits: vec4<u32> = nbToDigits(ts, params.nbColors);
      let digit: u32 = digits[index];
      let color: vec4<f32> = params.colors[digit];
      return vec4<f32>(color[0], color[1], color[2], 1.0);
    }

    // The main function of the fragment shader
    // TODO: It would be much smarter to compute the colors from the timestamp
    // once and for all, instead of running the same computation ~250 000 times
    // per frame (Alternatively, this could be done in the vertex shader and
    // passed as parameter to the fragment shader).
    @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
      if (uv.x > 0.5 && uv.y > 0.5) {
        let xcomp: f32 = (1 + sign(uv.x - 0.75)) / 2;
        let ycomp: f32 = (1 + sign(uv.y - 0.75)) / 2;
        let idx: u32 = u32(sign(xcomp) + 2 * sign(ycomp));
        return timestampToColor(params.timestamp, idx);
      }
      else {
        return textureSampleBaseClampToEdge(myTexture, mySampler, uv);
      }
    }
  `;


  // Internal variables used to set things up for WebGPU and keep track of
  // the setup so that the "transform" function can use it.
  let gpuDevice;
  let fragmentBindGroupLayout;
  let gpuPipeline;
  let textureSampler;

  // Convert hexadecimal rgb colors to GPU-friendly colors once and for all
  const colorBytes = config.colors.map(rgbToBytes).flat();

  // Create the canvas onto which we'll render. From a WebGPU perspective, a
  // canvas is not required since we're not going to display the result on
  // screen. We could rather render to a plain texture made from
  // "gpuDevice.createTexture()", as described in:
  // https://github.com/gpuweb/gpuweb/discussions/3420#discussioncomment-3580711
  // However, the VideoFrame constructor cannot directly take a GPUBuffer as
  // input and converting it to an ArrayBuffer would, I think, force a copy
  // to the CPU memory that should best be avoided at this stage. Hence the
  // canvas.
  const canvas = new OffscreenCanvas(
    config?.width ?? 1920,
    config?.height ?? 1080
  );
  const gpuCanvasContext = canvas.getContext('webgpu');

  return {
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
            code: vertexShaderSource
          }),
          entryPoint: 'vert_main'
        },
        fragment: {
          module: gpuDevice.createShaderModule({
            code: fragmentShaderSource
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
     * To process the new frame, parameters need to be sent to the GPU through
     * a GPUBuffer. That is easier said than done. As apparently everyone
     * should know, the offset of a struct member of type
     * "array<vec4<u32>, 64>" in address space "uniform" must be a multiple of
     * 16 bytes. The first two parameters in the structure take only 8 bytes,
     * so we need to leave 8 additional bytes before we can send the colors.
     * No error would be raised if we fail to do that (except if GPUBuffer
     * size is not large enough) but colors wouldn't be the right ones, since
     * RGBA components would be shifted by 2.
     */
    transform(frame, controller) {
      // Adjust the size of the canvas to the size of the frame to process
      // (In our case, all frames should have the same size so this is not
      // really needed)
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;

      // Save the frame's timestamp
      const timestamp = frame.timestamp;

      // Prepare the GPUBuffer that will contain the parameters sent to the
      // GPU (note the additional 8 bytes, and the offset at which colorBytes
      // gets written).
      // Note we can only encode reasonable numbers so timestamp gets
      // converted to milliseconds.
      const paramsBuffer = gpuDevice.createBuffer({
        size: 2 * 4 + 8 + 64 * 4 * 4,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST,
        mappedAtCreation: true
      });
      const map = new Float32Array(paramsBuffer.getMappedRange());
      map[0] = timestamp;
      map[1] = config.colors.length;
      map.set(colorBytes, 4);
      paramsBuffer.unmap();

      // Create the binding group with the sample, the texture and the params
      const uniformBindGroup = gpuDevice.createBindGroup({
        layout: fragmentBindGroupLayout,
        entries: [
          { binding: 0, resource: textureSampler },
          { binding: 1, resource: gpuDevice.importExternalTexture({source: frame}) },
          { binding: 2, resource: { buffer: paramsBuffer } }
        ],
      });

      // The rest is pretty much boilerplate to prepare, queue and run draw
      // commands on the GPU. 6 draws are needed, 3 per triangle.
      // (Note the draw commands are for the vertex shader, the fragment
      // shader gets called with interpolated coordinates for each pixel
      // in the triangles, in other words more than a million of times per
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

      // Create and enqueue a VideoFrame out of the canvas
      // Synchronization note: Once the GPUTexture has been created on the
      // canvas' context through the call to getCurrentTexture() a bit earlier,
      // any read operation on the canvas' content will be delayed until the
      // results of the processing are available. No need to wait on
      // `onSubmittedWorkDone` although note that, if GPU processing takes a
      // long time, the script will be paused accordingly.
      // See https://github.com/gpuweb/gpuweb/issues/3762#issuecomment-1398339650
      const processedFrame = new VideoFrame(canvas, {
        timestamp: timestamp,
        alpha: 'discard'
      });
      controller.enqueue(processedFrame);
    }
  };
}