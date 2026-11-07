/** Decode only the visible page, one photo at a time, without running analysis. */
export function createThumbnailQueue({
  getRecords, getVisibleRecords, isPaused, makeThumbnail, publish, onError, revoke,
}) {
  let generation = 0;
  let running = false;
  let scheduled = false;
  let requested = false;
  let inFlight = null;

  function currentRecord(id, epoch) {
    return epoch === generation ? getRecords().find(record => record.id === id) : null;
  }

  function nextRecord() {
    const records = new Map(getRecords().map(record => [record.id, record]));
    for (const visible of getVisibleRecords()) {
      const current = records.get(visible.id);
      if (current && !current.thumbnail && !current.thumbnailError) return current;
    }
    return null;
  }

  function schedule() {
    if (running || scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      if (requested) void pump();
    });
  }

  async function pump() {
    if (running) return;
    running = true;
    requested = false;
    const epoch = generation;
    try {
      while (epoch === generation && !isPaused()) {
        const record = nextRecord();
        if (!record) break;
        const task = (async () => {
          let thumbnail;
          try {
            thumbnail = await makeThumbnail(record);
            const current = currentRecord(record.id, epoch);
            if (!current || current.thumbnail) {
              if (thumbnail?.url && thumbnail.url !== current?.thumbnail) revoke(thumbnail.url);
              return;
            }
            publish(current, thumbnail);
          } catch (error) {
            // A rejected decode belongs only to its original source generation.
            if (thumbnail?.url) revoke(thumbnail.url);
            const current = currentRecord(record.id, epoch);
            if (current && !current.thumbnail) onError(current, error);
          }
        })();
        inFlight = task;
        try { await task; }
        finally { if (inFlight === task) inFlight = null; }
      }
    } finally {
      running = false;
      // A source/page change during decoding may have requested a fresh pump.
      if (requested) schedule();
    }
  }

  return {
    refresh() { requested = true; schedule(); },
    reset() { generation += 1; requested = false; },
    async waitForIdle() {
      // Jobs pause the queue first, then wait for just the current decode.
      const active = inFlight;
      if (active) await active;
    },
  };
}
