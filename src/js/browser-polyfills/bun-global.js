(function(){
  if(globalThis.__bun_wasm_serve_installed)return;
  globalThis.__bun_wasm_serve_installed=true;
  globalThis.__bun_routes=globalThis.__bun_routes||Object.create(null);
  globalThis.__bun_next_port=globalThis.__bun_next_port||40000;
  // ── Bun.serve ──────────────────────────────────────────────────
  function serve(opts){
    if(!opts||typeof opts.fetch!=='function')throw new TypeError('Bun.serve requires { fetch }');
    var port=opts.port;
    if(port===undefined||port===0)port=globalThis.__bun_next_port++;
    globalThis.__bun_routes[port]={fetch:opts.fetch,hostname:opts.hostname||'localhost',development:!!opts.development};
    return {
      port:port,
      hostname:opts.hostname||'localhost',
      url:new URL('http://'+(opts.hostname||'localhost')+':'+port+'/'),
      stop:function(){delete globalThis.__bun_routes[port];},
      reload:function(newOpts){if(newOpts&&typeof newOpts.fetch==='function')globalThis.__bun_routes[port].fetch=newOpts.fetch;},
      development:!!opts.development,
      pendingRequests:0,pendingWebSockets:0,
      publish:function(){return 0;},
      upgrade:function(){return false;},
      requestIP:function(){return null;},
      timeout:function(){},
      unref:function(){return this;},ref:function(){return this;},
    };
  }
  /** Host fetch dispatch — returns Promise<Response>. */
  function __dispatch(port,reqInit){
    var route=globalThis.__bun_routes[port];
    if(!route)return Promise.resolve(new Response('no route for port '+port,{status:502}));
    try{
      var url=reqInit.url||('http://localhost:'+port+'/');
      var init={method:reqInit.method||'GET'};
      if(reqInit.headers)init.headers=reqInit.headers;
      if(reqInit.body!==undefined&&reqInit.body!==null)init.body=reqInit.body;
      var req=new Request(url,init);
      return Promise.resolve(route.fetch(req));
    }catch(e){return Promise.resolve(new Response(String(e),{status:500}));}
  }
  // ── Phase 5.7 helpers ──────────────────────────────────────────
  function __mimeFor(p){
    if(p.endsWith('.json'))return 'application/json';
    if(p.endsWith('.js')||p.endsWith('.mjs')||p.endsWith('.ts')||p.endsWith('.tsx')||p.endsWith('.jsx'))return 'text/javascript';
    if(p.endsWith('.html')||p.endsWith('.htm'))return 'text/html';
    if(p.endsWith('.css'))return 'text/css';
    if(p.endsWith('.txt'))return 'text/plain';
    if(p.endsWith('.png'))return 'image/png';
    if(p.endsWith('.svg'))return 'image/svg+xml';
    return 'application/octet-stream';
  }
  function __inspect(v,opts){
    var depth=opts&&typeof opts.depth==='number'?opts.depth:2;
    var seen=[];
    function fmt(x,d){
      if(x===null)return 'null';
      if(x===undefined)return 'undefined';
      if(typeof x==='string')return JSON.stringify(x);
      if(typeof x==='bigint')return x.toString()+'n';
      if(typeof x!=='object'&&typeof x!=='function')return String(x);
      if(typeof x==='function')return '[Function: '+(x.name||'(anonymous)')+']';
      if(seen.indexOf(x)>=0)return '[Circular]';
      if(d<=0)return Array.isArray(x)?'[Array]':'[Object]';
      seen.push(x);
      try{
        if(x instanceof Error)return x.stack||x.message||String(x);
        if(Array.isArray(x)){return '[ '+x.map(function(i){return fmt(i,d-1);}).join(', ')+' ]';}
        var keys=Object.keys(x);
        if(!keys.length)return '{}';
        return '{ '+keys.map(function(k){return k+': '+fmt(x[k],d-1);}).join(', ')+' }';
      }finally{seen.pop();}
    }
    return fmt(v,depth);
  }
  // Capture HostFn refs before we delete them from globalThis
  var __fileRead   = globalThis.__bun_file_read;
  var __fileSize   = globalThis.__bun_file_size;
  var __fileWrite  = globalThis.__bun_file_write;
  var __resolveSyn = globalThis.__bun_resolve_sync;
  var __gunzip     = globalThis.__bun_gunzip_sync;
  var __transpile  = globalThis.__bun_transpile_code;
  // ── Bun object ─────────────────────────────────────────────────
  var __bunObj={
    serve:serve,
    version:'0.1.0-bun-browser',
    revision:'00000000000000000000000000000000',
    // process aliases
    get env(){return globalThis.process?globalThis.process.env:{};},
    set env(v){if(globalThis.process)globalThis.process.env=v;},
    get argv(){return globalThis.process?globalThis.process.argv:['bun'];},
    get main(){var a=globalThis.process&&globalThis.process.argv;return(a&&a[1])||'/';},
    // async sleep
    sleep:function(ms){return new Promise(function(r){setTimeout(r,ms||0);});},
    sleepSync:function(){},
    // which — no PATH in browser
    which:function(){return null;},
    // inspect
    inspect:__inspect,
    // Bun.file(path) — lazy VFS reader
    file:function(path){
      return{
        name:path,type:__mimeFor(path),
        text:function(){return Promise.resolve(new TextDecoder().decode(new Uint8Array(__fileRead(path))));},
        arrayBuffer:function(){return Promise.resolve(__fileRead(path));},
        bytes:function(){return Promise.resolve(new Uint8Array(__fileRead(path)));},
        json:function(){return Promise.resolve(JSON.parse(new TextDecoder().decode(new Uint8Array(__fileRead(path)))));},
        stream:function(){var ab=__fileRead(path);return new ReadableStream({start:function(c){c.enqueue(new Uint8Array(ab));c.close();}});},
        get size(){return __fileSize(path);},
      };
    },
    // Bun.write(dest, data) — writes to VFS, returns Promise<number>
    write:function(dest,data){
      if(data&&typeof data.text==='function'&&typeof data!=='string'){
        return data.text().then(function(t){return __fileWrite(dest,t);});
      }
      return Promise.resolve(__fileWrite(dest,data));
    },
    // Bun.resolveSync(spec, from)
    resolveSync:function(spec,from){return __resolveSyn(spec,from||'/');},
    // Bun.gunzipSync / gzipSync
    gunzipSync:function(data){
      var ab=data instanceof Uint8Array?data:new Uint8Array(data instanceof ArrayBuffer?data:data.buffer||data);
      return new Uint8Array(__gunzip(ab).buffer);
    },
    gzipSync:function(){throw new Error('Bun.gzipSync: compression not available in browser mode');},
    // Bun.Transpiler
    Transpiler:(function(){
      function Transpiler(opts){this._opts=opts||{};}
      Transpiler.prototype.transform=function(code,opts){
        var loader=(opts&&opts.loader)||this._opts.loader||'ts';
        return Promise.resolve(__transpile(code,'file.'+loader));
      };
      Transpiler.prototype.transformSync=function(code,opts){
        var loader=(opts&&opts.loader)||this._opts.loader||'ts';
        return __transpile(code,'file.'+loader);
      };
      Transpiler.prototype.scan=function(){return{imports:[],exports:[]};};
      Transpiler.prototype.scanImports=function(){return[];};
      return Transpiler;
    })(),
    // Bun.password — stub (no native crypto in sandbox)
    password:{
      hash:function(){return Promise.reject(new Error('Bun.password not available in browser mode'));},
      verify:function(){return Promise.reject(new Error('Bun.password not available in browser mode'));},
    },
    // Bun.hash — stub (use Web Crypto API for real hashes)
    hash:Object.assign(function(data){return 0;},{
      wyhash:function(){return 0;},crc32:function(){return 0;},adler32:function(){return 0;},
      cityHash32:function(){return 0;},cityHash64:function(){return BigInt(0);},
      xxHash32:function(){return 0;},xxHash64:function(){return BigInt(0);},
      murmur32v3:function(){return 0;},murmur64v2:function(){return BigInt(0);},
    }),
    // Bun.deepEquals / Bun.deepMatch — use JSON-roundtrip heuristic
    deepEquals:function(a,b){try{return JSON.stringify(a)===JSON.stringify(b);}catch{return a===b;}},
    deepMatch:function(a,b){
      if(b===null||typeof b!=='object')return a===b;
      return Object.keys(b).every(function(k){return __bunObj.deepMatch(a[k],b[k]);});
    },
    // Bun.color / Bun.enableANSIColors — terminal color (no-op in browser)
    enableANSIColors:false,
    color:function(v){return String(v);},
  };
  if(globalThis.Bun&&globalThis.Bun.serve)globalThis.__bun_real_Bun=globalThis.Bun;
  var __replaced=false;
  try{Object.defineProperty(globalThis,'Bun',{value:__bunObj,writable:true,configurable:true});__replaced=(globalThis.Bun===__bunObj);}catch(_e){}
  if(!__replaced){try{globalThis.Bun=__bunObj;__replaced=(globalThis.Bun===__bunObj);}catch(_e){}}
  if(!__replaced&&globalThis.Bun){
    var __keys=Object.keys(__bunObj);
    for(var __i=0;__i<__keys.length;__i++){
      try{Object.defineProperty(globalThis.Bun,__keys[__i],{value:__bunObj[__keys[__i]],writable:true,configurable:true});}catch(_e){try{globalThis.Bun[__keys[__i]]=__bunObj[__keys[__i]];}catch(_e2){}}
    }
  }
  globalThis.__bun_dispatch_fetch=__dispatch;
  // cleanup temporary HostFn globals
  delete globalThis.__bun_file_read;
  delete globalThis.__bun_file_size;
  delete globalThis.__bun_file_write;
  delete globalThis.__bun_resolve_sync;
  delete globalThis.__bun_gunzip_sync;
  delete globalThis.__bun_transpile_code;
})();
