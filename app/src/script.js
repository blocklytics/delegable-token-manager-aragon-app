import Aragon, { events } from '@aragon/api'
import tokenSettings, { hasLoadedTokenSettings } from './token-settings'
import { addressesEqual } from './web3-utils'
import BN from 'bn.js'
import tokenAbi from './abi/DelegableMiniMeToken.json'

const app = new Aragon()

/*
 * Calls `callback` exponentially, everytime `retry()` is called.
 * Returns a promise that resolves with the callback's result if it (eventually) succeeds.
 *
 * Usage:
 *
 * retryEvery(retry => {
 *  // do something
 *
 *  if (condition) {
 *    // retry in 1, 2, 4, 8 seconds… as long as the condition passes.
 *    retry()
 *  }
 * }, 1000, 2)
 *
 */
const retryEvery = async (
  callback,
  { initialRetryTimer = 1000, increaseFactor = 3, maxRetries = 3 } = {}
) => {
  const sleep = time => new Promise(resolve => setTimeout(resolve, time))

  let retryNum = 0
  const attempt = async (retryTimer = initialRetryTimer) => {
    try {
      return await callback()
    } catch (err) {
      if (retryNum === maxRetries) {
        throw err
      }
      ++retryNum

      // Exponentially backoff attempts
      const nextRetryTime = retryTimer * increaseFactor
      console.log(
        `Retrying in ${nextRetryTime}s... (attempt ${retryNum} of ${maxRetries})`
      )
      await sleep(nextRetryTime)
      return attempt(nextRetryTime)
    }
  }

  return attempt()
}

// Get the token address to initialize ourselves
retryEvery(() =>
  app
    .call('token')
    .toPromise()
    .then(marshallAddress)
    .then(initialize)
    .catch(err => {
      console.error(
        'Could not start background script execution due to the contract not loading the token:',
        err
      )
      throw err
    })
)

async function initialize(tokenAddress) {
  const token = app.external(tokenAddress, tokenAbi)

  function reducer(state, { address, event, returnValues }) {
    const nextState = {
      ...state,
    }

    if (event === events.SYNC_STATUS_SYNCING) {
      return { ...nextState, isSyncing: true }
    } else if (event === events.SYNC_STATUS_SYNCED) {
      return { ...nextState, isSyncing: false }
    }

    // Token event
    if (addressesEqual(address, tokenAddress)) {
      switch (event) {
        case 'ClaimedTokens':
          if (addressesEqual(returnValues._token, tokenAddress)) {
            return claimedTokens(token, nextState, returnValues)
          }
          return nextState
        case 'Transfer':
          return transfer(token, nextState, returnValues)
        case 'Delegate':
          return delegate(token, nextState, returnValues)
        case 'UnDelegate':
          return undelegate(token, nextState, returnValues)
        default:
          return nextState
      }
    }

    // Token Manager events
    switch (event) {
      case 'NewVesting':
        return newVesting(nextState, returnValues)
      default:
        // TODO: add handlers for the other vesting events
        return nextState
    }
  }

  const storeOptions = {
    externals: [{ contract: token }],
    init: initState({ token, tokenAddress }),
  }

  return app.store(reducer, storeOptions)
}

function initState({ token, tokenAddress }) {
  return async cachedState => {
    try {
      const tokenSymbol = await token.symbol().toPromise()
      app.identify(tokenSymbol)
    } catch (err) {
      console.error(
        `Failed to load token symbol for token at ${tokenAddress} due to:`,
        err
      )
    }

    const tokenSettings = hasLoadedTokenSettings(cachedState)
      ? {}
      : await loadTokenSettings(token)

    const maxAccountTokens = await app.call('maxAccountTokens').toPromise()

    const inititalState = {
      ...cachedState,
      isSyncing: true,
      tokenAddress,
      maxAccountTokens,
      ...tokenSettings,
    }

    // It's safe to not refresh the balances of all tokenholders
    // because we process any event that could change balances, even with block caching

    return inititalState
  }
}
/***********************
 *                     *
 *   Event Handlers    *
 *                     *
 ***********************/

async function claimedTokens(token, state, { _token, _controller }) {
  const newBalances = await loadNewBalances(token, _token, _controller)
  const newShares = await loadNewShares(token, _token, _controller)
  const newDelegatedBalance = await loadDelegatedBalances(
    token,
    _token,
    _controller
  )
  return updateTokenState(state, newBalances, newShares, newDelegatedBalance)
}

async function transfer(token, state, { _from, _to }) {
  const newBalances = await loadNewBalances(token, _from, _to)
  const newShares = await loadNewShares(token, _from, _to)
  const newDelegatedBalance = await loadDelegatedBalances(token, _from, _to)

  // The transfer may have increased the token's total supply, so let's refresh it
  const tokenSupply = await token.totalSupply().toPromise()
  return updateTokenState(
    {
      ...state,
      tokenSupply,
    },
    newBalances,
    newShares,
    newDelegatedBalance
  )
}

async function delegate(token, state, { _owner, _delegate }) {
  const newBalances = await loadNewBalances(token, _owner, _delegate)
  const newShares = await loadNewShares(token, _owner, _delegate)
  const newDelegatedBalance = await loadDelegatedBalances(
    token,
    _owner,
    _delegate
  )
  return updateTokenState(state, newBalances, newShares, newDelegatedBalance)
}

async function undelegate(token, state, { _owner, _delegate }) {
  const newBalances = await loadNewBalances(token, _owner, _delegate)
  const newShares = await loadNewShares(token, _owner, _delegate)
  const newDelegatedBalance = await loadDelegatedBalances(
    token,
    _owner,
    _delegate
  )
  return updateTokenState(state, newBalances, newShares, newDelegatedBalance)
}

async function newVesting(state, { receiver, vestingId }) {
  const vestingData = await loadVesting(receiver, vestingId)
  return updateVestingState(state, receiver, {
    id: vestingId,
    data: vestingData,
  })
}

/***********************
 *                     *
 *       Helpers       *
 *                     *
 ***********************/

function updateTokenState(state, newBalances, newShares, newDelegatedBalances) {
  const { holders = [], balances = {}, delegations = {} } = state
  return {
    ...state,
    holders: newShares.reduce(updateHolders, holders),
    balances: updateBalances(balances, newBalances),
    delegations: updateDelegations(delegations, newDelegatedBalances),
  }
}

function updateHolders(holders, changed) {
  const holderIndex = holders.findIndex(holder =>
    addressesEqual(holder.address, changed.address)
  )

  if (holderIndex === -1) {
    // If we can't find it, concat
    return holders.concat(changed)
  } else {
    const nextHolders = Array.from(holders)
    nextHolders[holderIndex] = changed
    return nextHolders
  }
}

function updateBalances(balances, newBalances) {
  newBalances.map((address, newBalance) => {
    balances[address] = new BN(newBalance)
  })
  return balances
}

function updateDelegations(delegations, newDelegations) {
  newDelegations.map((address, newDelegation) => {
    delegations[address] = new BN(newDelegation)
  })
  return delegations
}

function updateVestingState(state, receiver, newVesting) {
  const { vestings = {} } = state
  const address = receiver.toLowerCase()

  const nextVestings = {
    ...vestings,
    [address]: updateVestingsForAddress(vestings[address] || [], newVesting),
  }

  return {
    ...state,
    vestings: nextVestings,
  }
}

function updateVestingsForAddress(vestingsForAddress, newVesting) {
  const vestingIndex = vestingsForAddress.findIndex(
    vesting => vesting.id === newVesting.id
  )
  if (vestingIndex === -1) {
    // Can't find it; concat
    return vestingsForAddress.concat(newVesting)
  }

  // Update existing vesting
  const nextVestingsForAddress = Array.from(vestingsForAddress)
  nextVestingsForAddress[vestingIndex] = newVesting
  return nextVestingsForAddress
}

function loadNewShares(token, ...addresses) {
  return Promise.all(
    addresses.map(marshallAddress).map(address =>
      token
        .shares(address)
        .toPromise()
        .then(shares => ({ address, shares }))
    )
  ).catch(err => {
    console.error(
      `Failed to load new shares for ${addresses.join(', ')} due to:`,
      err
    )
    // Return an empty object to avoid changing any state
    // TODO: ideally, this would actually cause the UI to show "unknown" for the address
    return {}
  })
}

function loadNewBalances(token, ...addresses) {
  return Promise.all(
    addresses.map(marshallAddress).map(address =>
      token
        .delegableBalance(address)
        .toPromise()
        .then(delegableBalance => ({ address, delegableBalance }))
    )
  ).catch(err => {
    console.error(
      `Failed to load new balances for ${addresses.join(', ')} due to:`,
      err
    )
    // Return an empty object to avoid changing any state
    // TODO: ideally, this would actually cause the UI to show "unknown" for the address
    return {}
  })
}

function loadDelegatedBalances(token, ...addresses) {
  return Promise.all(
    addresses.map(marshallAddress).map(address =>
      token
        .delegatedTo(address)
        .toPromise()
        .then(delegatedBalance => ({ address, delegatedBalance }))
    )
  ).catch(err => {
    console.error(
      `Failed to load new balances for ${addresses.join(', ')} due to:`,
      err
    )
    // Return an empty object to avoid changing any state
    // TODO: ideally, this would actually cause the UI to show "unknown" for the address
    return {}
  })
}

function loadTokenSettings(token) {
  return Promise.all(
    tokenSettings.map(([name, key]) =>
      token[name]()
        .toPromise()
        .then(value => ({ [key]: value }))
    )
  )
    .then(settings =>
      settings.reduce((acc, setting) => ({ ...acc, ...setting }), {})
    )
    .catch(err => {
      console.error("Failed to load token's settings", err)
      // Return an empty object to try again later
      return {}
    })
}

function loadVesting(receiver, vestingId) {
  // Wrap with retry in case the vesting is somehow not present
  return retryEvery(() =>
    app
      .call('getVesting', receiver, vestingId)
      .toPromise()
      .then(vesting => marshallVesting(vesting))
  )
}

// Apply transformations to a vesting received from web3
// Note: ignores the 'open' field as we calculate that locally
function marshallVesting({ amount, cliff, revokable, start, vesting }) {
  return {
    amount,
    revokable,
    cliff: marshallDate(cliff),
    start: marshallDate(start),
    vesting: marshallDate(vesting),
  }
}

function marshallAddress(address) {
  // On machine-returned addresses, always assume they are correct
  return address.toLowerCase()
}

function marshallDate(date) {
  // Represent dates as real numbers, as it's very unlikely they'll hit the limit...
  // Adjust for js time (in ms vs s)
  return parseInt(date, 10) * 1000
}
