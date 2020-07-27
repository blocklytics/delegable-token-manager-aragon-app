import React, { useMemo, useCallback } from 'react'
import PropTypes from 'prop-types'
import BN from 'bn.js'
import { useConnectedAccount } from '@aragon/api-react'
import {
  ContextMenu,
  ContextMenuItem,
  DataView,
  GU,
  IconAdd,
  IconInfo,
  IconLabel,
  IconRemove,
  Split,
  formatTokenAmount,
  textStyle,
  useLayout,
  useTheme,
} from '@aragon/ui'
import { addressesEqual } from '../web3-utils'
import InfoBoxes from '../components/InfoBoxes'
import LocalIdentityBadge from '../components/LocalIdentityBadge/LocalIdentityBadge'
import { useIdentity } from '../components/IdentityManager/IdentityManager'
import You from '../components/You'

function Holders({
  groupMode,
  holders,
  balances,
  delegations,
  maxAccountTokens,
  onAssignTokens,
  onRemoveTokens,
  tokenAddress,
  tokenDecimals,
  tokenDecimalsBase,
  tokenName,
  tokenSupply,
  tokenSymbol,
  tokenTransfersEnabled,
  tokenDelegationEnabled,
  selectHolder,
  vestings,
}) {
  const { layoutName } = useLayout()
  const compact = layoutName === 'small'
  const connectedAccount = useConnectedAccount()

  const mappedEntries = useMemo(
    () =>
      holders.map(({ address, shares }) => {
        const balance =
          balances && balances[address] ? balances[address] : new BN(0)
        const delegated =
          delegations && delegations[address] ? delegations[address] : new BN(0)
        if (vestings[address]) {
          return [address, shares, delegated, balance, vestings[address]]
        }

        return [address, shares, delegated, balance, []]
      }),
    [holders, balances, delegations, vestings]
  )

  return (
    <Split
      primary={
        <DataView
          fields={
            groupMode
              ? ['Owner']
              : ['Holder', 'Shares', 'Delegated Shares', 'Delegable Balance']
          }
          entries={mappedEntries}
          renderEntry={([address, shares, delegated, balance]) => {
            const isCurrentUser = addressesEqual(address, connectedAccount)

            const values = [
              <div
                css={`
                  display: flex;
                  align-items: center;
                  /* On compact views, leave space for the rest of the data view */
                  max-width: ${compact
                    ? `calc(100vw - ${20 * GU}px)`
                    : 'unset'};
                `}
              >
                <LocalIdentityBadge
                  entity={address}
                  connectedAccount={isCurrentUser}
                />
                {isCurrentUser && <You css="flex-shrink: 0" />}
              </div>,
            ]

            if (!groupMode) {
              values.push(
                <TokenAmount balance={shares} tokenDecimals={tokenDecimals} />
              )
              values.push(
                <TokenAmount
                  balance={delegated}
                  tokenDecimals={tokenDecimals}
                />
              )
              values.push(
                <TokenAmount balance={balance} tokenDecimals={tokenDecimals} />
              )
            }

            return values
          }}
          renderEntryActions={([address, balance, vestings]) => (
            <EntryActions
              address={address}
              onAssignTokens={onAssignTokens}
              onRemoveTokens={onRemoveTokens}
              onSelectHolder={selectHolder}
              singleToken={groupMode || balance.eq(tokenDecimalsBase)}
              canAssign={!groupMode && balance.lt(maxAccountTokens)}
              hasVestings={vestings.length > 0}
            />
          )}
        />
      }
      secondary={
        <InfoBoxes
          holders={holders}
          tokenAddress={tokenAddress}
          tokenDecimals={tokenDecimals}
          tokenName={tokenName}
          tokenSupply={tokenSupply}
          tokenSymbol={tokenSymbol}
          tokenTransfersEnabled={tokenTransfersEnabled}
          tokenDelegationEnabled={tokenDelegationEnabled}
        />
      }
    />
  )
}

Holders.propTypes = {
  groupMode: PropTypes.bool,
  holders: PropTypes.array,
  maxAccountTokens: PropTypes.instanceOf(BN),
  onAssignTokens: PropTypes.func.isRequired,
  onRemoveTokens: PropTypes.func.isRequired,
  tokenAddress: PropTypes.string,
  tokenDecimals: PropTypes.instanceOf(BN),
  tokenDecimalsBase: PropTypes.instanceOf(BN),
  tokenName: PropTypes.string,
  tokenSupply: PropTypes.instanceOf(BN),
  tokenSymbol: PropTypes.string,
  tokenTransfersEnabled: PropTypes.bool,
  tokenDelegationEnabled: PropTypes.bool,
}

Holders.defaultProps = {
  holders: [],
}

function EntryActions({
  address,
  onAssignTokens,
  onRemoveTokens,
  onSelectHolder,
  singleToken,
  canAssign,
  hasVestings,
}) {
  const theme = useTheme()
  const [label, showLocalIdentityModal] = useIdentity(address)

  const editLabel = useCallback(() => showLocalIdentityModal(address), [
    address,
    showLocalIdentityModal,
  ])
  const assignTokens = useCallback(() => onAssignTokens(address), [
    address,
    onAssignTokens,
  ])
  const removeTokens = useCallback(() => onRemoveTokens(address), [
    address,
    onRemoveTokens,
  ])

  const selectHolder = useCallback(() => onSelectHolder(address), [
    address,
    onSelectHolder,
  ])
  const actions = [
    ...(hasVestings ? [[selectHolder, IconInfo, 'Details']] : []),
    ...(canAssign ? [[assignTokens, IconAdd, 'Add tokens']] : []),
    [removeTokens, IconRemove, `Remove token${singleToken ? '' : 's'}`],
    [editLabel, IconLabel, `${label ? 'Edit' : 'Add'} custom label`],
  ]

  return (
    <ContextMenu zIndex={1}>
      {actions.map(([onClick, Icon, label], index) => (
        <ContextMenuItem onClick={onClick} key={index}>
          <span
            css={`
              position: relative;
              display: flex;
              align-items: center;
              justify-content: center;
              color: ${theme.surfaceContentSecondary};
            `}
          >
            <Icon />
          </span>
          <span
            css={`
              margin-left: ${1 * GU}px;
            `}
          >
            {label}
          </span>
        </ContextMenuItem>
      ))}
    </ContextMenu>
  )
}

function TokenAmount({ balance, tokenDecimals }) {
  return (
    <div
      css={`
        display: flex;
        align-items: center;
      `}
    >
      {formatTokenAmount(balance, tokenDecimals)}
    </div>
  )
}

export default Holders
