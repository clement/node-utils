var http = require('http')
  , url = require('url')
  , sys = require('sys')
  , Iconv = require('iconv').Iconv
  ;

var compress;
try {
    compress = require('compress');
}
catch (e) {
    sys.log('node-compress is required to support gzip compression in HTTP requests');
}

var cookiejar;
try {
    cookiejar = require('cookiejar');
}
catch (e) {
    sys.log('cookiejar is required to handle cookie during redirects chains');
}


var toBase64 = function(str) {
  return  (new Buffer(str || "", "ascii")).toString("base64");
};

var postResponseErrorHandler = function(e) {
  sys.log("received an error after the end of the response `"+e+"`");
};

function request (options, callback) {
  if (!options.uri) {
    throw new Error("options.uri is a required argument")
  } else {
    if (typeof options.uri == "string") {
      options.uri = url.parse(options.uri);
    }
  }
  
  options._redirectsFollowed = options._redirectsFollowed ? options._redirectsFollowed : 0;
  options.maxRedirects = options.maxRedirects ? options.maxRedirects : 10;
  options.jar = options.jar || (cookiejar && (new cookiejar.CookieJar()));
    
  options.followRedirect = (options.followRedirect !== undefined) ? options.followRedirect : true;
  options.method = options.method ? options.method : 'GET';
  
  options.headers = options.headers ? options.headers :  {};
  if (!options.headers.host) {
    options.headers.host = options.uri.hostname;
    if (options.uri.port) {
      if ( !(options.uri.port === 80 && options.uri.protocol === 'http:') && 
           !(options.uri.port === 443 && options.uri.protocol === 'https:') )
      options.headers.host += (':'+options.uri.port)
    }
    var setHost = true;
  } else {
    var setHost = false;
  }
  if (options.gzip && compress) {
      options.headers['accept-encoding'] = 'gzip;q=1.0';
  }
  
  if (!options.uri.pathname) {options.uri.pathname = '/'}
  if (!options.uri.port) {
    if (options.uri.protocol == 'http:') {options.uri.port = 80}
    else if (options.uri.protocol == 'https:') {options.uri.port = 443}
  }
  
  if (options.uri.protocol == 'https:') {
    var secure = true; 
  } else {
    var secure = false;
  }
  
  if (options.jar) {
      options.headers['Cookie'] = options.jar.getCookies({domain:options.uri.hostname,
                                                          path:options.uri.pathname,
                                                          secure:secure})
                                             .map(function (cookie) { return cookie.toValueString(); })
                                             .join(';');
  }

  if (options.bodyStream) {
    sys.error('options.bodyStream is deprecated. use options.reponseBodyStream instead.');
    options.responseBodyStream = options.bodyStream;
  }
  
  options.client = options.client ? options.client : http.createClient(options.uri.port, options.uri.hostname, secure);
  
  var clientErrorHandler = function (error) {
    if (setHost) delete options.headers.host;
    if (callback) callback(error);
  }
  options.client.addListener('error', clientErrorHandler);
  
  if (options.uri.auth && !options.headers.authorization) {
    options.headers.authorization = "Basic " + toBase64(options.uri.auth);
  }
  options.fullpath = options.uri.href.replace(options.uri.protocol + '//' + options.uri.host, '');
  if (options.fullpath.length === 0) options.fullpath = '/' 
  if (options.body) {options.headers['content-length'] = options.body.length}
  options.request = options.client.request(options.method, options.fullpath, options.headers);
  
  options.request.addListener("response", function (response) {
    var buffer, responseStream;

    // If we get a gzip encoding, pump the response in a stream decoder,
    // and connect the rest of event listeners to the decoder
    if (response.headers['content-encoding'] && response.headers['content-encoding'] == 'gzip') {
        if (!compress) {
            clientErrorHandler(new Error("Cannot decode gzip response, please install `node-compress`"));
            return;
        }
        responseStream = new compress.GunzipStream();
        // Pump the response body in the decoding stream
        sys.pump(response, responseStream);
    }
    else {
        responseStream = response;
    }

    if (options.responseBodyStream) {
      buffer = options.responseBodyStream;
      sys.pump(responseStream, options.responseBodyStream);
    }
    else {
      buffer = new Buffer(0);
      responseStream.addListener("data", function (chunk) {
          // Buffer concatenation
          var acc = new Buffer(buffer.length + chunk.length);
          if (buffer.length) { buffer.copy(acc, 0, 0); }
          chunk.copy(acc, buffer.length, 0);
          buffer = acc;
        });
    }


    var closeTimeout;
    // If the server closes the connection before sending all the request,
    // we're sitting ducks
    options.client.addListener("close", function () {
            // Let's give some time to the response to catch up,
            // then fire manually the end event
            closeTimeout = setTimeout(function () { responseStream.emit("end"); }, options.closeTimeout || 10000);
        });
    
    responseStream.addListener("end", function () {
      options.client.removeListener("error", clientErrorHandler);
      /* Some errors can happen after the `end` event has been received,
       * for example, with an invalid Content-Length. Attaching a no-op
       * handler avoid having node crashing in those cases */
      options.client.addListener("error", postResponseErrorHandler);
      // Remove the timeout if necessary, and also detach the "end" listener
      // in the edge case when the response took more than the timeout to
      // reach the end state after closing the underlying socket
      if (closeTimeout) { clearTimeout(closeTimeout); }
      responseStream.removeListener("end", arguments.callee);
      
      if (response.statusCode > 299 && response.statusCode < 400 && options.followRedirect && response.headers.location && (options._redirectsFollowed < options.maxRedirects) ) {
        options._redirectsFollowed += 1

        // Set cookies
        if (options.jar && response.headers['set-cookie']) {
            // Can be hazardous with cookiejar (see commits in my fork clement/cookiejar)
            try {
                options.jar.setCookies(response.headers['set-cookie']);
            }
            catch (e) {
                sys.log('Error parsing cookies: '+e);
            }
        }

        options.uri = url.resolve(options.uri, response.headers.location);
        delete options.client; 
        if (options.headers) {
          delete options.headers.host;
        }
        request(options, callback);
        return;
      } else {options._redirectsFollowed = 0}
      
      if (!options.responseBodyStream) {
        // Convert the response body to a proper unicode string

        // Assume utf-8 if we can't get the charset
        // from the HTTP headers
        var charset = 'utf-8';
        if (response.headers['content-type']) {
          var match = /;\s*charset=([^\s;]+)\s*(?:;|$)/.exec(response.headers['content-type']);
          if (match) {
            charset = match[1];
          }
        }

        try {
          // Use iconv only if we're not already in UTF-8
          if (charset.toLowerCase() != 'utf-8') {
              buffer = (new Iconv(charset, 'utf-8')).convert(buffer);
          }
          buffer = buffer.toString();
        } catch (e) {
          // Keep binary encoding, and log the error
          sys.log('Got an error while converting '+options.uri.href+' from '+charset+' ('+(response.headers['content-type']||'')+') to UTF-8');
          buffer = buffer.toString('binary');
        }
      }

      if (setHost) delete options.headers.host;
      if (callback) callback(null, response, buffer);
    })
  })
  
  if (options.body) {
    options.request.write(options.body, 'binary');
    options.request.end();
  } else if (options.requestBodyStream) {
    sys.pump(options.requestBodyStream, options.request);
  } else {
    options.request.end();
  }
}

module.exports = request;

request.get = request;
request.post = function () {arguments[0].method = 'POST', request.apply(request, arguments)};
request.put = function () {arguments[0].method = 'PUT', request.apply(request, arguments)};
request.head = function () {arguments[0].method = 'HEAD', request.apply(request, arguments)};
