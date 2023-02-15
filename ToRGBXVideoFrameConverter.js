'use strict';


/**
 * Returns a transformer for a TransformStream that can process a stream of
 * VideoFrames and return the same stream of VideoFrames with all frames in
 * the RGBX format (regardless of the pixel format the frames were originally
 * using).
 *
 * The transformer uses WebGPU to perform the conversion.
 *
 * By definition, the transformer copies the underlying media resource to GPU
 * memory if it is not there already.
 */
function ToRGBXVideoFrameConverter(config) {
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
   * Expects a sampler, used to get pixels out of a texture, and an external
   * texture that represents the frame to draw.
   *
   * The shader returns the color of the pixel to render, in other words the
   * color of the corresponding pixel in the video frame. The sampler
   * automatically handles textures encoded in YUV formats to RGBX along the
   * way.
   */
  const fragmentShaderSource = `
    @group(0) @binding(0) var mySampler: sampler;
    @group(0) @binding(1) var myTexture: texture_external;

    // The main function of the fragment shader
    @fragment
    fn frag_main(@location(0) uv : vec2<f32>) -> @location(0) vec4<f32> {
      return textureSampleBaseClampToEdge(myTexture, mySampler, uv);
    }
  `;


  // Internal variables used to set things up for WebGPU and keep track of
  // the setup so that the "transform" function can use it.
  let gpuDevice;
  let gpuPipeline;
  let textureSampler;

  // Create the canvas onto which we'll render. From a WebGPU perspective, a
  // canvas is not required since we're not going to display the result on
  // screen. We could rather render to a plain texture made from
  // "gpuDevice.createTexture()", as described in:
  // https://github.com/gpuweb/gpuweb/discussions/3420#discussioncomment-3580711
  // However, the VideoFrame constructor cannot directly take a GPUBuffer as
  // input.
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

      // The format determines the conversion that will take place.
      // (Note that, if we had used getPreferredCanvadFormat(), result could
      // have been 'brga8unorm', which would swap color components)
      const format = 'rgba8unorm';
      gpuCanvasContext.configure({
        device: gpuDevice,
        format: format,
        alphaMode: 'opaque',
      });

      // Define the GPU render pipeline which, as all render pipelines,
      // consists of a vertex shader that returns a list of triangles (2
      // triangles that cover the whole canvas in our case) and a fragment
      // shader that computes the color of each point in these triangles.
      // The WGSL source of the shaders is at the end of this file.
      gpuPipeline = gpuDevice.createRenderPipeline({
        layout: 'auto',
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
      // No need to convert a frame that is already in the right format
      if ((frame.format === 'RGBA') || (frame.format === 'RGBX')) {
        controller.enqueue(frame);
        return;
      }

      // Adjust the size of the canvas to the size of the frame to process
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;

      // Save the frame's timestamp
      const timestamp = frame.timestamp;

      // Create the binding group with the sample, the texture and the params
      const uniformBindGroup = gpuDevice.createBindGroup({
        layout: gpuPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: textureSampler },
          { binding: 1, resource: gpuDevice.importExternalTexture({source: frame}) }
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