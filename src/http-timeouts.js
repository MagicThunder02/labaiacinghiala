const pendingRequests = new WeakMap();

function configureHttpTimeouts(server, {
  requestTimeoutMs = 5 * 60 * 1000,
  uploadIdleTimeoutMs = 130 * 1000,
} = {}) {
  // Node's parser deadline applies to the entire body, even while bytes arrive.
  // Replace it with a per-request deadline that authenticated uploads can relax.
  server.requestTimeout = 0;
  server.headersTimeout = 60 * 1000;

  server.prependListener('request', (req, res) => {
    const socket = req.socket;
    let timer;
    let uploading = false;
    let finished = false;

    function cleanup() {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      pendingRequests.delete(req);
      req.off('end', cleanup);
      req.off('close', cleanup);
      req.off('timeout', expire);
      res.off('finish', responseFinished);
      // Receipt has ended: do not time out import work or leak this setting
      // into another request on the same keep-alive connection.
      if (uploading && !socket.destroyed) socket.setTimeout(server.timeout);
    }

    function responseFinished() {
      // An early refusal can finish the response while Node is still draining
      // its body. Keep the receipt deadline until that body ends or disconnects.
      if (req.complete) cleanup();
    }

    function expire() {
      if (finished) return;
      // The parser may have received everything without the handler consuming
      // the stream (for example an empty POST starting a long library scan).
      if (req.complete) {
        cleanup();
        return;
      }
      cleanup();
      if (res.headersSent) {
        req.destroy();
        return;
      }
      res.once('finish', () => req.destroy());
      res.writeHead(408, {
        'Content-Type': 'application/json; charset=utf-8',
        Connection: 'close',
      });
      res.end(JSON.stringify({
        error: uploading
          ? `Caricamento interrotto: nessun dato ricevuto per ${Math.ceil(uploadIdleTimeoutMs / 1000)} secondi. Riprova.`
          : 'Tempo massimo di ricezione della richiesta superato.',
        code: uploading ? 'UPLOAD_IDLE_TIMEOUT' : 'REQUEST_BODY_TIMEOUT',
      }));
    }

    req.once('end', cleanup);
    req.once('close', cleanup);
    res.once('finish', responseFinished);
    timer = setTimeout(expire, requestTimeoutMs);
    timer.unref();

    pendingRequests.set(req, () => {
      if (finished || uploading) return;
      uploading = true;
      clearTimeout(timer);
      req.setTimeout(uploadIdleTimeoutMs, expire);
    });
  });
}

// Called only at the multipart receiver, after device/account/admin checks.
function allowLongUpload(req) {
  pendingRequests.get(req)?.();
}

module.exports = { configureHttpTimeouts, allowLongUpload };
