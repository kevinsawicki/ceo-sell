var async     = require('async');
var cheerio   = require('cheerio');
var ceos      = require('./ceos.json');
var Humanize  = require('humanize-plus');
var request   = require('request');
var url       = require('url');
var XmlStream = require('xml-stream');

var wrapCallback = function(callback) {
  var callbackCalled = false;
  return function() {
    if (!callbackCalled)
      callback.apply(null, arguments);
    callbackCalled = true;
  };
}

var getLatestFilings = function(id, callback) {
  callback = wrapCallback(callback);

  var requestOptions = {
    uri: 'http://www.sec.gov/cgi-bin/browse-edgar',
    qs: {
      action: 'getcompany',
      CIK: id,
      count: 10,
      output: 'atom',
      owner: 'include',
      type: 4
    }
  };
  var filingRequest = request(requestOptions);
  filingRequest.on('error', function(error) {
    callback(new Error("Failed to get latest filing for: " + id + ". " + error.message));
  });

  var filings = [];
  var filingUrl;
  var filingDate;

  var parser = new XmlStream(filingRequest, 'utf8');

  parser.on('startElement: entry', function() {
    filingUrl = '';
    filingDate = '';
  });

  parser.on('text: entry > content > filing-href', function (node) {
    filingUrl += node.$text;
  });

  parser.on('text: entry > updated', function (node) {
    filingDate += node.$text;
  });

  parser.on('endElement: entry', function() {
    filingUrl = filingUrl.trim();
    filingDate = Date.parse(filingDate.trim());
    if (filingUrl && isFinite(filingDate))
      filings.push({date: filingDate, rootUrl: filingUrl, id: id});
  });

  parser.on('end', function() {
    callback(null, filings);
  });

  parser.on('error', callback);
};

var getFilingXmlFileUrl = function(filingHref, callback) {
  callback = wrapCallback(callback);

  var folderUrl = url.resolve(filingHref, '.');
  request(folderUrl, function(error, response, body) {
    if (error) return callback(new Error("Request failed: " + folderUrl + " " + error.message));

    var fileName = cheerio(body).find('a[href$=".xml"]').first().text();
    if (!fileName) return callback(new Error("No link to XML file found: " + folderUrl));

    var fileUrl = url.resolve(folderUrl, fileName);
    callback(null, fileUrl);
  });
};

var getFilingHtmlFileUrl = function(filingHref, callback) {
  request(filingHref, function(error, response, body) {
    if (error) return callback(error);

    var htmlName = cheerio(body).find('a[href^="/Archives"]').first().attr('href');
    if (!htmlName) return callback(new Error("No link to HTML file found: " + filingHref));

    var htmlUrl = url.resolve('http://www.sec.gov/', htmlName);
    callback(null, htmlUrl);
  });
}

var parseFilingXml = function(companySymbol, xmlFileUrl, callback) {
  callback = wrapCallback(callback);
  var parser = new XmlStream(request(xmlFileUrl), 'utf8');

  var totalShares = 0;
  var amountInDollars = 0;

  var shares;
  var price;
  var type;
  var symbol = '';

  parser.on('startElement: transactionAmounts', function(name) {
    price =  '';
    shares = '';
    type = '';
  });

  parser.on('text: transactionAmounts > transactionShares > value', function(node) {
    shares += node.$text;
  });

  parser.on('text: transactionAmounts > transactionPricePerShare > value', function(node) {
    price += node.$text;
  });

  parser.on('text: transactionAmounts > transactionAcquiredDisposedCode > value', function(node) {
    type += node.$text;
  });

  parser.on('text: issuer > issuerTradingSymbol', function(node) {
    symbol += node.$text;
  });

  parser.on('endElement: issuerTradingSymbol', function(node) {
    if (companySymbol !== symbol.trim()) callback();
  });

  parser.on('endElement: transactionAmounts', function(name) {
    shares = parseFloat(shares);
    price = parseFloat(price)
    type = type.trim();
    if (type === 'D') {
      if (price > 0 && isFinite(price)) {
        if (shares > 0 && isFinite(shares)) {
          totalShares += shares;
          amountInDollars += price * shares;
        }
      }
    }
  });

  parser.on('end', function () {
    callback(null, totalShares, amountInDollars);
  });

  parser.on('error', callback);
};

var getFilling = function(filing, callback) {
  var tasks = [];

  tasks.push(function(callback) {
    getFilingXmlFileUrl(filing.rootUrl, function(error, xmlFileUrl) {
      filing.xmlUrl = xmlFileUrl;
      callback(error);
    });
  });

  tasks.push(function(callback) {
    getFilingHtmlFileUrl(filing.rootUrl, function(error, htmlFileUrl) {
      filing.htmlUrl = htmlFileUrl;
      callback(error);
    });
  });

  tasks.push(function(callback) {
    parseFilingXml(ceos[filing.id].symbol, filing.xmlUrl, function (error, shares, dollars) {
      filing.shares = shares;
      filing.dollars = dollars;
      callback(error);
    });
  });

  async.waterfall(tasks, callback);
};

var getLatestFiling = function(id, filingCallback) {
  getLatestFilings(id, function(error, filings) {
    if (error) return filingCallback(error);

    var queue = async.queue(function(filing, queueCallback) {
      getFilling(filing, function(error) {
        if (filing.shares > 0) {
          queue.kill();
          filingCallback(null, filing);
        }
        queueCallback();
      });
    });
    queue.push.call(queue, filings);
    queue.concurrency = 1;
  });

};

var generateTweet = function(ceo, results) {
  return ceo.name + " sold " + Humanize.compactInteger(results.shares, 0)
    + " shares for $" + Humanize.compactInteger(results.dollars, 1)
    + " on " + new Date(results.date).toString()
    + " " + results.htmlUrl;
}

var queue = async.queue(function(id, callback) {
  getLatestFiling(id, function(error, results) {
    if (error)
      console.error(error.message || error);
    else if (results && results.shares > 0 && results.dollars > 0)
      console.log(generateTweet(ceos[id], results));
    callback();
  });
});
queue.concurrency = 10;
queue.push.call(queue, Object.keys(ceos));
