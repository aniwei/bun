var PT=require('stream').PassThrough;
function _gun(d){if(typeof globalThis.Bun!=='undefined'&&typeof globalThis.Bun.gunzipSync==='function'){var u=d instanceof Uint8Array?d:new Uint8Array(d instanceof ArrayBuffer?d:d.buffer||d);return globalThis.Bun.gunzipSync(u);}throw new Error('zlib.gunzipSync: unavailable (Bun.gunzipSync not found)');}
module.exports={
  gunzipSync:function(b){return _gun(b);},
  inflateSync:function(b){return _gun(b);},
  unzipSync:function(b){return _gun(b);},
  brotliDecompressSync:function(){throw new Error('zlib.brotliDecompressSync: not available');},
  gzipSync:function(){throw new Error('zlib.gzipSync: compression not available in browser mode');},
  deflateSync:function(){throw new Error('zlib.deflateSync: not available in browser mode');},
  gunzip:function(b,o,cb){if(typeof o==='function'){cb=o;}try{cb(null,_gun(b));}catch(e){cb(e);}},
  inflate:function(b,o,cb){if(typeof o==='function'){cb=o;}try{cb(null,_gun(b));}catch(e){cb(e);}},
  gzip:function(b,o,cb){if(typeof o==='function'){cb=o;}cb(new Error('zlib.gzip not available in browser mode'));},
  deflate:function(b,o,cb){if(typeof o==='function'){cb=o;}cb(new Error('zlib.deflate not available in browser mode'));},
  createGunzip:function(){return new PT();},
  createInflate:function(){return new PT();},
  createUnzip:function(){return new PT();},
  createBrotliDecompress:function(){return new PT();},
  createGzip:function(){throw new Error('zlib.createGzip: not available in browser mode');},
  createDeflate:function(){throw new Error('zlib.createDeflate: not available in browser mode');},
  constants:{Z_NO_FLUSH:0,Z_PARTIAL_FLUSH:1,Z_SYNC_FLUSH:2,Z_FULL_FLUSH:3,Z_FINISH:4,Z_DEFAULT_COMPRESSION:-1,Z_BEST_SPEED:1,Z_BEST_COMPRESSION:9,Z_DEFAULT_STRATEGY:0,Z_DEFLATED:8}
};
