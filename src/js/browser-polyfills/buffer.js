(function(){
  var _enc=typeof TextEncoder!=='undefined'?new TextEncoder():null;
  var _dec=typeof TextDecoder!=='undefined'?new TextDecoder():null;
  function mkBuf(u8){
    if(!(u8 instanceof Uint8Array))u8=new Uint8Array(u8);
    Object.defineProperty(u8,'_isBunBuf',{value:true,enumerable:false,configurable:true});
    u8.toString=function(e){
      e=e||'utf8';
      if(e==='hex')return Array.from(this).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
      if(e==='base64'){var s='';for(var i=0;i<this.length;i++)s+=String.fromCharCode(this[i]);return btoa(s);}
      return _dec?_dec.decode(this):String.fromCharCode.apply(null,Array.from(this));
    };
    u8.equals=function(o){if(this.length!==o.length)return false;for(var i=0;i<this.length;i++)if(this[i]!==o[i])return false;return true;};
    u8.indexOf=function(v,off){
      off=off||0;
      if(typeof v==='number'){for(var i=off;i<this.length;i++)if(this[i]===v)return i;return -1;}
      var s=typeof v==='string'?(_enc?_enc.encode(v):new Uint8Array([].map.call(v,function(c){return c.charCodeAt(0);}))):v;
      outer:for(var i=off;i<=this.length-s.length;i++){for(var j=0;j<s.length;j++)if(this[i+j]!==s[j])continue outer;return i;}
      return -1;
    };
    u8.includes=function(v,off){return this.indexOf(v,off)>=0;};
    u8.readUInt8=function(o){return this[o||0];};
    u8.readInt8=function(o){var v=this[o||0];return v>=128?v-256:v;};
    u8.readUInt16BE=function(o){o=o||0;return(this[o]<<8)|this[o+1];};
    u8.readUInt16LE=function(o){o=o||0;return this[o]|(this[o+1]<<8);};
    u8.readUInt32BE=function(o){o=o||0;return((this[o]*0x1000000)+(this[o+1]<<16)+(this[o+2]<<8)+this[o+3])>>>0;};
    u8.readUInt32LE=function(o){o=o||0;return((this[o+3]*0x1000000)+(this[o+2]<<16)+(this[o+1]<<8)+this[o])>>>0;};
    u8.readInt32BE=function(o){return this.readUInt32BE(o)|0;};
    u8.readInt32LE=function(o){return this.readUInt32LE(o)|0;};
    u8.writeUInt8=function(v,o){this[o||0]=v&0xff;return(o||0)+1;};
    u8.writeUInt16BE=function(v,o){o=o||0;this[o]=(v>>>8)&0xff;this[o+1]=v&0xff;return o+2;};
    u8.writeUInt16LE=function(v,o){o=o||0;this[o]=v&0xff;this[o+1]=(v>>>8)&0xff;return o+2;};
    u8.writeUInt32BE=function(v,o){o=o||0;this[o]=(v>>>24)&0xff;this[o+1]=(v>>>16)&0xff;this[o+2]=(v>>>8)&0xff;this[o+3]=v&0xff;return o+4;};
    u8.writeUInt32LE=function(v,o){o=o||0;this[o]=v&0xff;this[o+1]=(v>>>8)&0xff;this[o+2]=(v>>>16)&0xff;this[o+3]=(v>>>24)&0xff;return o+4;};
    u8.write=function(s,off,len,e){off=off||0;e=e||'utf8';var b=_enc?_enc.encode(s):new Uint8Array([].map.call(s,function(c){return c.charCodeAt(0);}));if(len!==undefined)b=b.subarray(0,len);this.set(b,off);return b.length;};
    u8.copy=function(target,tOff,sOff,sEnd){var sub=this.subarray(sOff||0,sEnd||this.length);target.set(sub,tOff||0);return sub.length;};
    u8.slice=u8.subarray;
    return u8;
  }
  var Buffer={
    from:function(src,enc){
      if(typeof src==='string'){
        enc=enc||'utf8';
        if(enc==='hex'){var h=new Uint8Array(src.length>>1);for(var i=0;i<h.length;i++)h[i]=parseInt(src.slice(i*2,i*2+2),16);return mkBuf(h);}
        if(enc==='base64'){var bin=atob(src),b=new Uint8Array(bin.length);for(var j=0;j<bin.length;j++)b[j]=bin.charCodeAt(j);return mkBuf(b);}
        return mkBuf(_enc?_enc.encode(src):new Uint8Array([].map.call(src,function(c){return c.charCodeAt(0);})));
      }
      if(src instanceof ArrayBuffer)return mkBuf(new Uint8Array(src));
      if(ArrayBuffer.isView(src))return mkBuf(new Uint8Array(src.buffer,src.byteOffset,src.byteLength));
      if(typeof src==='number')return mkBuf(new Uint8Array(src));
      if(Array.isArray(src))return mkBuf(new Uint8Array(src));
      return mkBuf(new Uint8Array(0));
    },
    alloc:function(n,fill,e){var b=new Uint8Array(n);if(fill!==undefined){if(typeof fill==='string')b.fill(fill.charCodeAt(0));else b.fill(fill);}return mkBuf(b);},
    allocUnsafe:function(n){return mkBuf(new Uint8Array(n));},
    allocUnsafeSlow:function(n){return mkBuf(new Uint8Array(n));},
    isBuffer:function(v){return v!=null&&(v._isBunBuf===true||(v instanceof Uint8Array&&typeof v.toString==='function'&&v.toString.length<=1));},
    isEncoding:function(e){return['utf8','utf-8','hex','base64','ascii','latin1','binary','ucs2','utf16le'].indexOf((e||'').toLowerCase())>=0;},
    byteLength:function(s,e){if(s instanceof ArrayBuffer||ArrayBuffer.isView(s))return s.byteLength||s.length;e=(e||'utf8').toLowerCase();if(e==='hex')return(s.length>>1);if(e==='base64')return Math.floor(s.replace(/=/g,'').length*3/4);return _enc?_enc.encode(s).length:s.length;},
    concat:function(list,len){
      if(len===undefined)len=list.reduce(function(a,b){return a+(b.byteLength||b.length);},0);
      var r=new Uint8Array(len),off=0;
      for(var i=0;i<list.length;i++){r.set(list[i],off);off+=list[i].byteLength||list[i].length;}
      return mkBuf(r);
    },
    compare:function(a,b){for(var i=0;i<Math.min(a.length,b.length);i++){if(a[i]<b[i])return -1;if(a[i]>b[i])return 1;}return a.length<b.length?-1:a.length>b.length?1:0;},
    poolSize:8192,
  };
  if(typeof globalThis!=='undefined'&&!globalThis.Buffer)globalThis.Buffer=Buffer;
  module.exports={Buffer:Buffer,SlowBuffer:Buffer.alloc,kMaxLength:2147483647,INSPECT_MAX_BYTES:50};
  module.exports.Buffer=Buffer;
})();
