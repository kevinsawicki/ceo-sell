var cheerio   = require('cheerio');
var request   = require('request');
var url       = require('url');
var XmlStream = require('xml-stream');

var id = '0001513362';

var getLatestFiling = function(id, callback) {
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

  var parser = new XmlStream(request(requestOptions), 'utf8');
  parser.once('text: filing-href', function (node) {
    var text = node.$text.trim();
    callback(null, text);
  });
};

var getFilingXmlFileUrl = function(filingHref, callback) {
  var folderUrl = url.resolve(filingHref, '.');
  request(folderUrl, function(error, response, body) {
    var fileName = cheerio(body).find('a[href$=".xml"]').first().text();
    var fileUrl = url.resolve(folderUrl, fileName);
    callback(null, fileUrl);
  });
};

var parseFilingXml = function(xmlFileUrl, callback) {
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
};

getLatestFiling(id, function(error, filingHref) {
  getFilingXmlFileUrl(filingHref, function(error, xmlFileUrl) {
    parseFilingXml(xmlFileUrl, function(error, shares, cost) {
      console.log(shares, cost);
    });
  })
});
