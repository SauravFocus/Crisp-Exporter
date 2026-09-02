Issue: Crisp exporter fails with large data exports.

If export runs for several hours (5–6 hrs), when returning to the Crisp tab, the JSON/data is no longer downloadable (likely session timeout or lost state).

Task:

- Identify root cause (timeout, memory, frontend state, or backend job handling)
- Make export reliable for large datasets
- Ensure download is still available after long processing time
- Prefer background job + persistent storage (e.g., save file and provide download लिंक)
- Avoid losing progress if user leaves the page

Do not overcomplicate. Focus on a robust, production-ready fix.
