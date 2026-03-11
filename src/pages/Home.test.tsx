import { render, screen } from '@testing-library/react'
import { describe, it, expect } from 'vitest'
import { Home } from './Home'

describe('Home', () => {
  it('renders the heading', () => {
    render(<Home />)
    expect(screen.getByRole('heading', { name: /browser wallet/i })).toBeInTheDocument()
  })
})
