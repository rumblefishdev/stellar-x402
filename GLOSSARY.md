# stellar-x402

An x402 facilitator for Stellar: it verifies and settles paid requests, and keeps the Bazaar, a
catalog of the paid resources it has settled. Each term has one English name, used in code and
docs, and one Polish word (_Po polsku_), used when the work is discussed in Polish.

## Payment

**Client**:
The party that requests a paid resource and signs the payment for it.
_Avoid_: buyer, customer
_Po polsku_: klient

**Payer**:
The account whose funds a settled payment moves. Usually the client, but anyone can pay for any
resource.
_Avoid_: sender
_Po polsku_: płatnik

**Seller**:
The party that serves a paid resource and receives its payments.
_Avoid_: merchant, vendor
_Po polsku_: sprzedawca

**Resource server**:
The seller's service that answers an unpaid request with a 402 and asks the facilitator to settle
a paid one.
_Avoid_: seller server, backend
_Po polsku_: serwer sprzedawcy

**Facilitator**:
This service: it verifies and settles payments for sellers and pays their network fees.
_Po polsku_: facilitator

**payTo**:
The account a seller names to receive a payment.
_Avoid_: recipient, destination
_Po polsku_: konto sprzedawcy

**Offer**:
One way a seller accepts payment for a resource: scheme, network, asset, amount and payTo. A 402
lists the seller's offers; x402 calls each one `PaymentRequirements`.
_Avoid_: requirement, accept, price
_Po polsku_: oferta

**Scheme**:
The rule for how a payment is authorized and charged: `exact` charges the signed amount, `upto`
charges actual usage up to a ceiling the client signed.
_Po polsku_: schemat

**Ceiling**:
The largest amount a client authorizes in an `upto` payment.
_Avoid_: max, limit, cap
_Po polsku_: pułap

**Verification**:
The facilitator's check that a signed payment would settle, without putting it on chain.
_Po polsku_: weryfikacja

**Settlement**:
Putting a signed payment on chain and reporting its outcome.
_Avoid_: submission, execution
_Po polsku_: rozliczenie

**Channel account**:
A Stellar account the facilitator controls and uses as a transaction's source, so that several
settlements can land in one ledger.
_Avoid_: channel, signer, pool account
_Po polsku_: konto kanałowe

**Fee bump**:
The outer transaction through which the facilitator pays a settlement's network fee.
_Po polsku_: fee bump

## Catalog

**Bazaar**:
The catalog of paid resources that the facilitator builds from settled payments.
_Avoid_: index, registry, discovery
_Po polsku_: katalog

**Resource**:
One paid HTTP route or MCP tool.
_Avoid_: endpoint, service
_Po polsku_: zasób

**Listing**:
The Bazaar's entry for one resource of one seller, with its description and offers.
_Avoid_: catalog entry, resource entry, item
_Po polsku_: wpis

**Listing key**:
What makes a listing unique: network, payTo, method or tool, and resource URL.
_Avoid_: catalog key, entry id
_Po polsku_: klucz wpisu

**Cataloging**:
Turning a settled payment that carries the Bazaar extension into a new or changed listing.
_Avoid_: indexing, registration
_Po polsku_: katalogowanie

**Payment's copy**:
The listing content a client sends with a payment, copied from the seller's 402.
_Avoid_: echo, echoed content, copy (alone)
_Po polsku_: kopia z płatności

**Seller check**:
The facilitator's unpaid request to the seller, whose 402 decides what a listing says.
_Avoid_: seller-page check, verification, probe
_Po polsku_: sprawdzenie u sprzedawcy

**Listing attempt**:
One try to create or change a listing, kept with its outcome, accepted or not.
_Avoid_: catalog attempt, write
_Po polsku_: próba wpisu

**Soft drop**:
Leaving out a malformed optional field of a listing while keeping the rest.
_Avoid_: strip, sanitize
_Po polsku_: pominięcie pola
