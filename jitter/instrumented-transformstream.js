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