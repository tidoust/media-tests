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

    const instrumentedTransformer = Object.assign({}, transformer, {
      async transform(chunk, controller) {
        let stats = InstrumentedTransformStream.#stats.find(s => s.ts === chunk.timestamp);
        if (!stats) {
          stats = {
            ts: chunk.timestamp
          };
          InstrumentedTransformStream.#stats.push(stats);
        }
        stats[timerName] = {
          start: performance.timeOrigin + performance.now()
        };
        await transformer.transform.apply(this, [chunk, controller]);
        if (!stats[timerName].end) {
          stats[timerName].end = performance.timeOrigin + performance.now();
        }
      },

      setEndTime(timestamp) {
        const stats = InstrumentedTransformStream.#stats.find(s => s.ts === timestamp);
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