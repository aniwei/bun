// Phase 5.1 T5.1.4: prefer __bun_url_parse (Zig std.Uri backed) over browser URL
var _urlParse=(typeof __bun_url_parse!=='undefined')?__bun_url_parse:null;
var _URL=(typeof URL!=='undefined'?URL:(globalThis.URL||null));
function fileURLToPath(url){
  var href=typeof url==='string'?url:url.href;
  if(_urlParse){try{var r=_urlParse(href);if(r)return r.pathname||href;}catch(e){}}
  if(!_URL)return href.replace(/^file:\/\//,'');
  try{return new _URL(href).pathname;}catch(e){return href;}
}
function pathToFileURL(path){
  var p=path&&path[0]==='/'?path:'/'+path;
  if(_urlParse){try{var r=_urlParse('file://'+p);if(r)return r;}catch(e){}}
  if(_URL)return new _URL('file://'+p);
  return{href:'file://'+p,pathname:p};
}
function parse(urlStr){
  if(_urlParse){try{return _urlParse(urlStr);}catch(e){return null;}}
  if(!_URL)return null;
  try{var u=new _URL(urlStr);return{href:u.href,protocol:u.protocol,hostname:u.hostname,port:u.port||null,pathname:u.pathname,search:u.search||null,hash:u.hash||null,host:u.host,auth:null};}
  catch(e){return null;}
}
function format(urlObj){
  if(typeof urlObj==='string')return urlObj;
  if(urlObj&&typeof urlObj.href==='string')return urlObj.href;
  return '';
}
module.exports={URL:_URL,fileURLToPath:fileURLToPath,pathToFileURL:pathToFileURL,parse:parse,format:format};
