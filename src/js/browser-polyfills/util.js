function format(fmt){
  if(typeof fmt!=='string'){var a=Array.prototype.slice.call(arguments);return a.map(function(x){try{return typeof x==='object'&&x!==null?JSON.stringify(x):String(x);}catch(e){return String(x);}}).join(' ');}
  var i=1,args=arguments;
  var s=fmt.replace(/%[sdifjoO%]/g,function(m){
    if(m==='%%')return'%';if(i>=args.length)return m;var v=args[i++];
    if(m==='%s')return String(v);if(m==='%d'||m==='%i')return Math.floor(Number(v));if(m==='%f')return Number(v);
    try{return JSON.stringify(v);}catch(e){return'[Circular]';}
  });
  if(i<args.length)s+=' '+Array.prototype.slice.call(args,i).join(' ');
  return s;
}
function inspect(v){try{return JSON.stringify(v,null,2);}catch(e){return String(v);}}
function promisify(fn){return function(){var a=Array.prototype.slice.call(arguments);return new Promise(function(res,rej){fn.apply(null,a.concat(function(e,v){e?rej(e):res(v);}));});};}
module.exports={format:format,inspect:inspect,promisify:promisify,debuglog:function(){return function(){};},deprecate:function(fn){return fn;},isDeepStrictEqual:function(a,b){return JSON.stringify(a)===JSON.stringify(b);}};
