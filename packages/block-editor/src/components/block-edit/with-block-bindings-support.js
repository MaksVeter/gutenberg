/**
 * WordPress dependencies
 */
import { store as blocksStore } from '@wordpress/blocks';
import { createHigherOrderComponent } from '@wordpress/compose';
import { useRegistry, useSelect } from '@wordpress/data';
import { useCallback, useMemo, useContext } from '@wordpress/element';

/**
 * Internal dependencies
 */
import isURLLike from '../link-control/is-url-like';
import { unlock } from '../../lock-unlock';
import BlockContext from '../block-context';
import {
	BLOCK_BINDINGS_ALLOWED_BLOCKS,
	canBindAttribute,
} from '../../utils/block-bindings';

/** @typedef {import('@wordpress/compose').WPHigherOrderComponent} WPHigherOrderComponent */

const DEFAULT_ATTRIBUTE = '__default';

/**
 * Returns the bindings with the `__default` binding for pattern overrides
 * replaced with the full-set of supported attributes. e.g.:
 *
 * bindings passed in: `{ __default: { source: 'core/pattern-overrides' } }`
 * bindings returned: `{ content: { source: 'core/pattern-overrides' } }`
 *
 * @param {string} blockName The block name (e.g. 'core/paragraph').
 * @param {Object} bindings  A block's bindings from the metadata attribute.
 *
 * @return {Object} The bindings with default replaced for pattern overrides.
 */
function replacePatternOverrideDefaultBindings( blockName, bindings ) {
	// The `__default` binding currently only works for pattern overrides.
	if (
		bindings?.[ DEFAULT_ATTRIBUTE ]?.source === 'core/pattern-overrides'
	) {
		const supportedAttributes = BLOCK_BINDINGS_ALLOWED_BLOCKS[ blockName ];
		const bindingsWithDefaults = {};
		for ( const attributeName of supportedAttributes ) {
			// If the block has mixed binding sources, retain any non pattern override bindings.
			const bindingSource = bindings[ attributeName ]
				? bindings[ attributeName ]
				: { source: 'core/pattern-overrides' };
			bindingsWithDefaults[ attributeName ] = bindingSource;
		}

		return bindingsWithDefaults;
	}

	return bindings;
}

/**
 * Given a binding of block attributes, returns a higher order component that
 * overrides its `attributes` and `setAttributes` props to sync any changes needed.
 *
 * @return {WPHigherOrderComponent} Higher-order component.
 */
export const withBlockBindingsSupport = createHigherOrderComponent(
	( BlockEdit ) => ( props ) => {
		const registry = useRegistry();
		const blockContext = useContext( BlockContext );
		const sources = useSelect( ( select ) =>
			unlock( select( blocksStore ) ).getAllBlockBindingsSources()
		);
		const { name, clientId, context, setAttributes } = props;
		const blockBindings = useMemo(
			() =>
				replacePatternOverrideDefaultBindings(
					name,
					props.attributes?.metadata?.bindings
				),
			[ props.attributes?.metadata?.bindings, name ]
		);

		// While this hook doesn't directly call any selectors, `useSelect` is
		// used purposely here to ensure `boundAttributes` is updated whenever
		// there are attribute updates.
		// `source.getValues` may also call a selector via `registry.select`.
		const updatedContext = {};
		const boundAttributes = useSelect(
			( select ) => {
				if ( ! blockBindings ) {
					return;
				}

				const attributes = {};

				const blockBindingsBySource = new Map();

				for ( const [ attributeName, binding ] of Object.entries(
					blockBindings
				) ) {
					const { source: sourceName, args: sourceArgs } = binding;
					const source = sources[ sourceName ];
					if (
						! source ||
						! canBindAttribute( name, attributeName )
					) {
						continue;
					}

					// Populate context.
					for ( const key of source.usesContext || [] ) {
						updatedContext[ key ] = blockContext[ key ];
					}

					blockBindingsBySource.set( source, {
						...blockBindingsBySource.get( source ),
						[ attributeName ]: {
							args: sourceArgs,
						},
					} );
				}

				if ( blockBindingsBySource.size ) {
					for ( const [
						source,
						bindings,
					] of blockBindingsBySource ) {
						// Get values in batch if the source supports it.
						let values = {};
						if ( ! source.getValues ) {
							Object.keys( bindings ).forEach( ( attr ) => {
								// Default to the the source label when `getValues` doesn't exist.
								values[ attr ] = source.label;
							} );
						} else {
							values = source.getValues( {
								select,
								context: updatedContext,
								clientId,
								bindings,
							} );
						}
						for ( const [ attributeName, value ] of Object.entries(
							values
						) ) {
							if (
								attributeName === 'url' &&
								( ! value || ! isURLLike( value ) )
							) {
								// Return null if value is not a valid URL.
								attributes[ attributeName ] = null;
							} else {
								attributes[ attributeName ] = value;
							}
						}
					}
				}

				return attributes;
			},
			[ blockBindings, name, clientId, updatedContext, sources ]
		);

		const hasParentPattern = !! updatedContext[ 'pattern/overrides' ];
		const hasPatternOverridesDefaultBinding =
			props.attributes?.metadata?.bindings?.[ DEFAULT_ATTRIBUTE ]
				?.source === 'core/pattern-overrides';

		const _setAttributes = useCallback(
			( nextAttributes ) => {
				registry.batch( () => {
					if ( ! blockBindings ) {
						setAttributes( nextAttributes );
						return;
					}

					const keptAttributes = { ...nextAttributes };
					const blockBindingsBySource = new Map();

					// Loop only over the updated attributes to avoid modifying the bound ones that haven't changed.
					for ( const [ attributeName, newValue ] of Object.entries(
						keptAttributes
					) ) {
						if (
							! blockBindings[ attributeName ] ||
							! canBindAttribute( name, attributeName )
						) {
							continue;
						}

						const binding = blockBindings[ attributeName ];
						const source = sources[ binding?.source ];
						if ( ! source?.setValues ) {
							continue;
						}
						blockBindingsBySource.set( source, {
							...blockBindingsBySource.get( source ),
							[ attributeName ]: {
								args: binding.args,
								newValue,
							},
						} );
						delete keptAttributes[ attributeName ];
					}

					if ( blockBindingsBySource.size ) {
						for ( const [
							source,
							bindings,
						] of blockBindingsBySource ) {
							source.setValues( {
								select: registry.select,
								dispatch: registry.dispatch,
								context: updatedContext,
								clientId,
								bindings,
							} );
						}
					}

					if (
						// Don't update non-connected attributes if the block is using pattern overrides
						// and the editing is happening while overriding the pattern (not editing the original).
						! (
							hasPatternOverridesDefaultBinding &&
							hasParentPattern
						) &&
						Object.keys( keptAttributes ).length
					) {
						// Don't update caption and href until they are supported.
						if ( hasPatternOverridesDefaultBinding ) {
							delete keptAttributes?.caption;
							delete keptAttributes?.href;
						}
						setAttributes( keptAttributes );
					}
				} );
			},
			[
				registry,
				blockBindings,
				name,
				clientId,
				updatedContext,
				setAttributes,
				sources,
				hasPatternOverridesDefaultBinding,
				hasParentPattern,
			]
		);

		return (
			<BlockEdit
				{ ...props }
				attributes={ { ...props.attributes, ...boundAttributes } }
				setAttributes={ _setAttributes }
				context={ { ...context, ...updatedContext } }
			/>
		);
	},
	'withBlockBindingSupport'
);
