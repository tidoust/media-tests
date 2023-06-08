/**
 * A simple in-memory database targeted at collecting step processing times for
 * a set of chunks in a stream.
 *
 * Each entry in the database represents times for a chunk. It is an object
 * with:
 * - Some identifier property. By default, the code expects an "id" property.
 * This can be overridden through the "chunkIdProperty" parameter passed to the
 * constructor.
 * - A set of properties that identify processing steps. Value each time is an
 * object with "start" and "end" properties that contain recorded timestamps at
 * which the step started and ended. The "end" property may not be set.
 *
 * For instance:
 * 
 * {
 *   "id": 24000,
 *   "input": { "start": 1614.0, "end": 1614.0 },
 *   "overlay": { "start": 1614.1, "end": 1616.2 },
 *   "display": { "start": 1616.5 }
 * }
 *
 * To use the db and get stats, you need to:
 * 1. create an instance
 * 2. add entries
 * 3. call computeStats
 * 
 * const timesDB = new StepTimesDB();
 * timesDB.addEntries(timeEntries);
 * const report = timesDB.computeStats();
 *
 * When a step only has a "start" time, the code assumes that the step ends when
 * the next chunk reaches the same processing step. That logic works well with
 * a "display" step in a stream of video frames where a frame replaces the
 * former one. It won't work for cases where "end" should rather be the start
 * time of next processing step (to handle these cases, calling code has to take
 * care of setting the "end" property itself).
 * 
 * Stats reported contain minimum, maximum, average, median and count stats for
 * step durations.
 * 
 * Stats reported also contain end-to-end statistics and the time spent in
 * between processing steps, i.e. time spent in queues, provided that the names
 * of the initial and final steps were given to the constructor.
 */

'use strict';


/**
 * A simple in-memory database targeted at collecting processing times for
 * individual chunks (video frames, typically) in a stream.
 */
class StepTimesDB {
  #chunkIdProperty;
  #initialStep;
  #finalStep;
  #excludeSteps;
  #times = [];

  constructor({ chunkIdProperty, initialStep, finalStep, excludeSteps } = {}) {
    this.#chunkIdProperty = chunkIdProperty ?? 'id';
    this.#initialStep = initialStep ?? null;
    this.#finalStep = finalStep ?? null;
    this.#excludeSteps = ['display'];
    this.#times = [];
  }

  reset() {
    this.#times = [];
  }

  find(id) {
    return this.#times.find(t => t[this.#chunkIdProperty] === id);
  }

  addEntry(entry) {
    if (!entry[this.#chunkIdProperty]) {
      return;
    }
    const existingEntry = this.#times.find(s =>
      s[this.#chunkIdProperty] === entry[this.#chunkIdProperty]);
    if (existingEntry) {
      Object.assign(existingEntry, entry);
    }
    else {
      this.#times.push(entry);
    }
  }

  addEntries(entries) {
    for (const entry of entries) {
      this.addEntry(entry);
    }
  }

  /**
   * Compute a report with min/max/avg/media statistics for collected times.
   */
  computeStats() {
    // Compute the time taken to process all chunks between given starting step
    // and final step. If final step is not provided, compute the time taken by
    // the starting step itself. Chunks for which we don't have the info are
    // skipped.
    const getDurations = (startingStep, finalStep) => {
      finalStep = finalStep ?? startingStep;
      return this.#times
        .filter(t => t[finalStep]?.end && t[startingStep]?.start)
        .map(t => t[finalStep].end - t[startingStep].start);
    }

    // Compute count, min, max, avg, median of the provided array of durations
    const computeStats = durations => {
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

    // Compute the time spent in between processing steps for the given chunk.
    // Return null if we don't have all start/end times. Skip steps that took
    // place after the final step (display is typically not included in
    // "processing" time)
    const computeQueuedDuration = stat => {
      const finalTime = this.#finalStep ? stat[this.#finalStep]?.start : null;
      const times = Object.values(stat)
        .filter(time => !finalTime || time.start <= finalTime)
        .sort((time1, time2) => {
          const diff = time1.start - time2.start;
          if (diff === 0) {
            return time1.end - time2.end;
          }
          else {
            return diff;
          }
        });
      if (times.find(t => !t.start || !t.end)) {
        return null;
      }
      return times.slice(0, -1)
        .map((time, idx) => times[idx + 1].start - time.end)
        .reduce((curr, total) => total += curr, 0);
    }

    // Compute a list of processing steps
    const steps = new Set();
    for (const stat of this.#times) {
      Object.keys(stat)
        .filter(step => step !== this.#chunkIdProperty)
        .forEach(step => steps.add(step));
    }

    // If we have the start time of a step but not its end time, we'll assume
    // that it lasted until the beginning of the same step for the next chunk
    // (typically useful for display: we know when a frame is expected to be
    // displayed, and we know it remains on display until the next frame gets
    // displayed).
    // TODO: the copy and sort is a bit heavy, should be done only when needed.
    for (const step of steps) {
      const times = this.#times.slice();
      times
        .sort((t1, t2) => t1[step]?.start - t2[step]?.start)
        .forEach((entry, index) => {
          if (entry[step]?.start && !entry[step].end) {
            let nextIndex = index + 1;
            let next = times[nextIndex];
            while (next) {
              if (next[step]?.start) {
                entry[step].end = next[step].start;
                break;
              }
              nextIndex++;
              next = times[nextIndex];
            }
          }
        });
    }

    const res = {
      all: this.#times,
      durations: this.#times.map(entry => {
        const durations = { id: entry[this.#chunkIdProperty] };
        for (const step of steps) {
          durations[step] = entry[step]?.start && entry[step]?.end ?
            Math.round(entry[step].end - entry[step].start) : 0;
        }
        durations.queued = computeQueuedDuration(entry);
        if (this.#initialStep && this.#finalStep) {
          durations.end2end = Math.round(entry[this.#finalStep]?.end - entry[this.#initialStep]?.start);
        }
        return durations;
      }),
      stats: {}
    };

    for (const step of steps) {
      res.stats[step] = computeStats(getDurations(step));
    }
    const queuedDurations = this.#times.map(computeQueuedDuration).filter(s => !!s);
    res.stats.queued = computeStats(queuedDurations);
    if (this.#initialStep && this.#finalStep) {
      res.stats.end2end = computeStats(getDurations(this.#initialStep, this.#finalStep));
    }

    return res;
  }
}
