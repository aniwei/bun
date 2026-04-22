(function(){
  if(globalThis.Buffer&&globalThis.Buffer.isBuffer)return;
  var Buf={
    from:function(src,enc){
      if(typeof src==='string'){
        enc=enc||'utf8';
        if(enc==='hex'){var h=new Uint8Array(src.length>>1);for(var i=0;i<h.length;i++)h[i]=parseInt(src.slice(i*2,i*2+2),16);return Buf._w(h);}
        if(enc==='base64'){var bin=atob(src),b=new Uint8Array(bin.length);for(var j=0;j<bin.length;j++)b[j]=bin.charCodeAt(j);return Buf._w(b);}
        return Buf._w(new TextEncoder().encode(src));
      }
      if(src instanceof ArrayBuffer)return Buf._w(new Uint8Array(src));
      if(ArrayBuffer.isView(src))return Buf._w(new Uint8Array(src.buffer,src.byteOffset,src.byteLength));
      if(Array.isArray(src))return Buf._w(new Uint8Array(src));
      return Buf._w(new Uint8Array(0));
    },
    alloc:function(n,fill){var b=new Uint8Array(n);if(fill!==undefined)b.fill(typeof fill==='number'?fill:fill.charCodeAt(0));return Buf._w(b);},
    allocUnsafe:function(n){return Buf._w(new Uint8Array(n));},
    isBuffer:function(v){return v!=null&&v._isBunBuf===true;},
    concat:function(list,len){
      if(len===undefined)len=list.reduce(function(a,b){return a+b.byteLength;},0);
      var r=new Uint8Array(len),off=0;
      for(var i=0;i<list.length;i++){r.set(list[i],off);off+=list[i].byteLength;}
      return Buf._w(r);
    },
    _w:function(u8){
      Object.defineProperty(u8,'_isBunBuf',{value:true,enumerable:false,configurable:true});
      u8.toString=function(enc){
        enc=enc||'utf8';
        if(enc==='utf8'||enc==='utf-8')return new TextDecoder().decode(this);
        if(enc==='base64')return btoa(String.fromCharCode.apply(null,Array.from(this)));
        if(enc==='hex')return Array.from(this).map(function(b){return b.toString(16).padStart(2,'0');}).join('');
        return String.fromCharCode.apply(null,Array.from(this));
      };
      return u8;
    }
  };
  globalThis.Buffer=Buf;
})();
