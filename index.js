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

var getLatestFiling = function(id, callback) {
  callback = wrapCallback(callback);

  var requestOptions = {
    uri: 'http://www.sec.gov/cgi-bin/browse-edgar',
    qs: {
      action: 'getcompany',
      CIK: id,
      count: 1,
      output: 'atom',
      owner: 'include',
      type: 4
    }
  };
  var filingRequest = request(requestOptions);
  filingRequest.on('error', callback);

  var filingUrl;

  var parser = new XmlStream(filingRequest, 'utf8');
  parser.once('text: entry > content > filing-href', function (node) {
    filingUrl = node.$text.trim();
  });

  parser.once('text: entry > updated', function (node) {
    var filingDate = Date.parse(node.$text);
    callback(null, filingUrl, filingDate);
  });

  parser.on('end', function() {
    callback(new Error("No filing URL and date parsed: " + id))
  });
};

var getFilingXmlFileUrl = function(filingHref, callback) {
  callback = wrapCallback(callback);

  var folderUrl = url.resolve(filingHref, '.');
  request(folderUrl, function(error, response, body) {
    if (error) return callback(error);

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

var parseFilingXml = function(xmlFileUrl, callback) {
  callback = wrapCallback(callback);
  var parser = new XmlStream(request(xmlFileUrl), 'utf8');

  var totalShares = 0;
  var amountInDollars = 0;

  var currentShares;
  var currentPrice;
  var currentType;

  parser.on('startElement: transactionAmounts', function(name) {
    currentPrice = 0;
    currentShares = 0;
    currentType = null;
  });

  parser.on('text: transactionAmounts > transactionShares > value', function(node) {
    currentShares = parseFloat(node.$text);
  });

  parser.on('text: transactionAmounts > transactionPricePerShare > value', function(node) {
    currentPrice = parseFloat(node.$text);
  });

  parser.on('text: transactionAmounts > transactionAcquiredDisposedCode > value', function(node) {
    currentType = node.$text.trim();
  });

  parser.on('endElement: transactionAmounts', function(name) {
    if (currentType === 'D') {
      if (currentPrice > 0 && isFinite(currentPrice)) {
        if (currentShares > 0 && isFinite(currentShares)) {
          totalShares += currentShares;
          amountInDollars += currentPrice * currentShares;
        }
      }
    }
  });

  parser.on('end', function () {
    callback(null, totalShares, amountInDollars);
  });

  parser.on('error', callback);
};

var getLatestTransaction = function(id, callback) {
  getLatestFiling(id, function(error, filingHref, filingDate) {
    if (error) return callback(error);

    getFilingXmlFileUrl(filingHref, function(error, xmlFileUrl) {
      if (error) return callback(error);

      getFilingHtmlFileUrl(filingHref, function(error, htmlFileUrl) {
        if (error) return callback(error);

        parseFilingXml(xmlFileUrl, function (error, shares, dollarAmount) {
          if (error) return callback(error);

          callback(null, htmlFileUrl, shares, dollarAmount, filingDate);
        });
      });
    });
  });
};

var generateTweet = function(ceo, filingUrl, shares, dollarAmount, filingDate) {
  return ceo.name + " sold " + Humanize.compactInteger(shares, 0) + " shares for $" + Humanize.compactInteger(dollarAmount, 1) + " on " + new Date(filingDate).toString() + " " + filingUrl;
}

Object.keys(ceos).forEach(function(id) {
  getLatestTransaction(id, function(error, filingUrl, shares, dollarAmount, filingDate) {
    if (shares > 0 && dollarAmount > 0)
      console.log(generateTweet(ceos[id], filingUrl, shares, dollarAmount, filingDate));
    else if (error)
      console.error(error.message || error);
  });
});
