/**
 * A drop-in replacement for TransformStream that records the time spent to
 * transform a chunk and stores the result in a static cache per chunk
 * (provided that chunks have identifiers) for later retrieval.
 *
 * Measurement of time only works for "simple" transforms, meaning those that
 * transform one chunk into zero or one other chunk. It won't work well for
 * transforms that take one chunk and produce more than one chunk out of it.
 * In these situations, the application must call `setEndTime` explicitly to
 * fix the end of the transformation.
 *
 * Calls to "controller.enqueue()" trigger the next TransformStream in the
 * pipeline right away. To avoid measuring time spent further down the
 * processing pipeline also as time spent in the current TransformStream, the
 * class intercepts the call to "controller.enqueue()" and considers that this
 * signals the end of the processing. Again, this only works for simple
 * transforms that do not need to do anything after the call to
 * "controller.enqueue()".
 *
 * Class was created to measure time taken processing AudioFrame and VideoFrame
 * objects or encoded versions of them. By default, it looks at the "timestamp"
 * property to get a chunk identifier. This can be overridden through the
 * "chunkIdProperty" parameter passed to the constructor.
 *
 * Usage:
 *
 * // Reset the static cache
 * InstrumentedTransformStream.resetStats();
 *
 * // By default, the transform will appear under `timer-xxx`, and code
 * // considers that the chunk's ID is to be found under a `timestamp` property.
 * const transformStream1 = new InstrumentedTransformStream(
 *   transformer,
 *   writableStrategy,
 *   readableStrategy);
 *
 * // The actual transform name and the name of the property that contains the
 * // chunk's identifier can be passed as arguments
 * const transformStream2 = new InstrumentedTransformStream({
 *   name: 'super-duper',
 *   chunkIdProperty: 'id',
 *   transform(chunk, controller) {
 *     const transformedChunk = doSomethingWith(chunk);
 *     controller.enqueue(transformedChunk);
 *   }
 * });
 *
 * // Retrieve stats once processing is done. This returns an array of entries
 * // per chunk. Each entry is an object that looks like:
 * // {
 * //   "id": "chunk id",
 * //   "timer-1": { start: timestamp, end: timestamp },
 * //   "super-duper": { start: timestamp, end: timestamp }
 * // }
 * const stats = InstrumentedTransformStream.collectStats();
 */

'use strict';


/**
 * A type of TransformStream that records the time spent to transform each frame
 * and stores the result in a static cache (using the frame's timestamp as
 * identifier) for later retrieval.
 * 
 * Measurement of time is not fully transparent because a typical "transform"
 * function will call "controller.enqueue()" at some point, which triggers the
 * next TransformStream in the pipeline right away. To avoid measuring time
 * spent further down in the processing pipeline, users of this class should
 * call "setEndTime()" before issuing a call to "controller.enqueue()" to signal
 * the end of the processing.
 * 
 * Note this can probably be improved (e.g. the class could probably intercept
 * the call to "controller.enqueue()" and assume that's the end of the
 * transformation).
 */
class InstrumentedTransformStream extends TransformStream {
  static #stats = [];
  static #timerLastId = 0;

  constructor(transformer,
              writableStrategy = {}, readableStrategy = {}) {
    /**
     * A wrapped version of TransformStreamDefaultController.
     *
     * Note the class cannot extend TransformStreamDefaultController because that
     * class does not expose a constructor.
     */
    class InstrumentedTransformStreamController {
      #controller;
      #stat;

      constructor(controller, stat) {
        this.#controller = controller;
        this.#stat = stat;
      }

      get desiredSize() {
        return this.#controller.desiredSize;
      }

      enqueue(chunk) {
        this.#stat.end = performance.timeOrigin + performance.now();
        return this.#controller.enqueue(chunk);
      }

      error(reason) {
        if (!this.#stat.end) {
          this.#stat.end = performance.timeOrigin + performance.now();
        }
        return this.#controller.error(reason);
      }

      terminate() {
        return this.#controller.terminate();
      }
    }

    if (!transformer) {
      transformer = {
        transform(chunk, controller) {
          controller.enqueue(chunk);
        }
      };
    }
    if (!transformer.transform) {
      transformer = Object.assign({
        transform(chunk, controller) {
          controller.enqueue(chunk);
        }
      }, transformer);
    }
    const timerName = transformer.name ??
      `timer-${InstrumentedTransformStream.#timerLastId++}`;
    const idProperty = transformer.chunkIdProperty ?? 'timestamp';

    const instrumentedTransformer = Object.assign({}, transformer, {
      async transform(chunk, controller) {
        const chunkId = chunk?.[idProperty] ?? '__unidentified';
        let stats = InstrumentedTransformStream.#stats.find(s => s.id === chunkId);
        if (!stats) {
          stats = {
            id: chunkId
          };
          InstrumentedTransformStream.#stats.push(stats);
        }
        stats[timerName] = {
          start: performance.timeOrigin + performance.now()
        };
        const instrumentedController = new InstrumentedTransformStreamController(controller, stats[timerName]);
        const res = await transformer.transform.apply(this, [chunk, instrumentedController]);

        // Transformation may not have called controller.enqueue
        if (!stats[timerName].end) {
          stats[timerName].end = performance.timeOrigin + performance.now();
        }
        return res;
      },

      setEndTime(chunkId) {
        const stats = InstrumentedTransformStream.#stats.find(s => s.id === chunkId);
        if (!stats) {
          return;
        }
        stats[timerName].end = performance.timeOrigin + performance.now();
      }
    });

    super(instrumentedTransformer, writableStrategy, readableStrategy);
  }

  static collectStats() {
    return InstrumentedTransformStream.#stats;
  }

  static resetStats() {
    InstrumentedTransformStream.#stats = [];
  }
}